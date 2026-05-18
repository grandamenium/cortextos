/**
 * rgos-mirror — fire-and-forget Supabase mirror for task and message writes.
 *
 * Called from createTask, updateTask, completeTask (task.ts) and
 * sendMessage (message.ts) after the local atomicWriteSync succeeds.
 * Never awaited by callers; a failing push goes to a local JSONL retry queue
 * and is drained asynchronously on the next successful write.
 *
 * Auth: SUPABASE_RGOS_SERVICE_KEY (service role JWT) + direct PostgREST.
 * Pattern matches analyst/prototype/sync_activity_to_supabase.py.
 *
 * Kill switch: BUS_RGOS_MIRROR_DISABLED=1 → immediate no-op.
 * Also no-ops when SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY are absent.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { join } from 'path';
import type { Task, InboxMessage } from '../types/index.js';
import { escalateCritical } from '../utils/escalate.js';

// ---------------------------------------------------------------------------
// UUIDv5 — deterministic UUID from bus ID (RFC 4122 §4.3, stdlib only)
// ---------------------------------------------------------------------------

// Fixed namespace (RFC 4122 DNS namespace — arbitrary but constant)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nsBytes(): Buffer {
  return Buffer.from(UUID_NAMESPACE.replace(/-/g, ''), 'hex');
}

export function uuidv5(name: string): string {
  const hash = createHash('sha1')
    .update(nsBytes())
    .update(Buffer.from(name, 'utf-8'))
    .digest();
  // Take first 16 bytes, set version (5) and variant (RFC 4122) bits
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.slice(0, 16).toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const RETRY_MAX = 500;
export const EVENT_RETRY_MAX = 3;
const MIRROR_SOURCE = 'cortextos_bus_mirror';

// Module-level drain lock — prevents parallel drain loops from stacking.
let draining = false;

// ---------------------------------------------------------------------------
// Kill switch + env checks
// ---------------------------------------------------------------------------

export function isEnabled(): boolean {
  if (process.env.BUS_RGOS_MIRROR_DISABLED === '1') return false;
  if (!process.env.SUPABASE_RGOS_URL) return false;
  if (!process.env.SUPABASE_RGOS_SERVICE_KEY) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Retry queue helpers
// ---------------------------------------------------------------------------

export interface RetryEntry {
  table: 'orch_tasks' | 'cortex_messages' | 'orch_events';
  row: Record<string, unknown>;
  ts: string;
  retries_remaining?: number;
}

export function retryQueuePath(): string | null {
  const ctxRoot = process.env.CTX_ROOT;
  const agentName = process.env.CTX_AGENT_NAME || process.env.CORTEXTOS_AGENT_NAME;
  if (!ctxRoot || !agentName) return null;
  return join(ctxRoot, 'state', agentName, 'mirror-retry.jsonl');
}

export function readRetryQueue(qPath: string): RetryEntry[] {
  if (!existsSync(qPath)) return [];
  try {
    return readFileSync(qPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as RetryEntry);
  } catch {
    return [];
  }
}

export function enqueueRetry(entry: RetryEntry): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  try {
    mkdirSync(join(qPath, '..'), { recursive: true });
    const existing = readRetryQueue(qPath);
    existing.push(entry);
    // FIFO eviction: drop oldest entries if over cap
    let trimmed = existing;
    if (existing.length > RETRY_MAX) {
      const dropped = existing.length - RETRY_MAX;
      console.warn(`[bus-mirror] WARN: retry queue at cap (${RETRY_MAX}); evicting ${dropped} oldest entr${dropped === 1 ? 'y' : 'ies'} — data loss`);
      trimmed = existing.slice(existing.length - RETRY_MAX);
    }
    atomicWriteSync(qPath, trimmed.map(e => JSON.stringify(e)).join('\n'));
  } catch {
    // Best-effort: never crash the caller over a retry queue write failure
  }
}

function clearRetryQueue(qPath: string): void {
  try {
    atomicWriteSync(qPath, '');
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// PostgREST error classification
// ---------------------------------------------------------------------------

/**
 * Permanent HTTP status codes — errors that will never resolve by retrying.
 *
 * - 400 Bad Request: malformed payload / schema mismatch
 * - 403 Forbidden: service-key auth failure (wrong key or RLS policy)
 * - 422 Unprocessable Entity: constraint violation (bad enum value, etc.)
 *
 * 500 / 503 / network errors / 409 FK violations are transient — re-queue.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 403, 422]);

export class PostgRESTError extends Error {
  constructor(
    public readonly status: number,
    public readonly isPermanent: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'PostgRESTError';
  }
}

// ---------------------------------------------------------------------------
// PostgREST upsert
// ---------------------------------------------------------------------------

async function postgrestUpsert(
  table: 'orch_tasks' | 'cortex_messages' | 'orch_events',
  row: Record<string, unknown>,
): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL!;
  const serviceKey = process.env.SUPABASE_RGOS_SERVICE_KEY!;
  const endpoint = `${url}/rest/v1/${table}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    // FK violation on reply_to_id (23503): parent message was never mirrored.
    // Strip reply_to_id and retry once — the reply becomes a standalone message
    // in RGOS rather than blocking the drain forever.
    if (
      res.status === 409 &&
      body.includes('"23503"') &&
      table === 'cortex_messages' &&
      row['reply_to_id'] != null
    ) {
      const retryRow = { ...row, reply_to_id: null };
      const retryRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(retryRow),
        signal: AbortSignal.timeout(10_000),
      });
      if (retryRes.ok) return; // retry succeeded
      const retryBody = await retryRes.text().catch(() => '');
      const retryPermanent = PERMANENT_HTTP_STATUSES.has(retryRes.status);
      throw new PostgRESTError(
        retryRes.status,
        retryPermanent,
        `PostgREST ${table} upsert failed ${retryRes.status} (after FK retry): ${retryBody.slice(0, 200)}`,
      );
    }

    const permanent = PERMANENT_HTTP_STATUSES.has(res.status);
    throw new PostgRESTError(
      res.status,
      permanent,
      `PostgREST ${table} upsert failed ${res.status}: ${body.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Retry drain (async, module-level concurrency lock)
// ---------------------------------------------------------------------------

export async function drainRetryQueue(): Promise<void> {
  if (draining) return; // Concurrency guard: only one drain loop at a time
  const qPath = retryQueuePath();
  if (!qPath) return;
  // Transparently migrate any pre-v5 entries before attempting upsert
  migrateRetryQueueIds();
  // Remap raw bus constraint values (priority=normal, status=pending, etc.)
  migrateRetryQueueConstraints();
  // Convert raw bus IDs in reply_to_id to UUIDv5
  migrateRetryQueueReplyToId();
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  draining = true;
  try {
    const failed: RetryEntry[] = [];
    let countProcessed = 0;
    let countDiscarded = 0;

    for (const entry of entries) {
      // Event entries carry a retry cap — discard when exhausted so stale events
      // do not clog the queue during extended outages (tasks/messages are unaffected).
      if (entry.retries_remaining !== undefined && entry.retries_remaining <= 0) {
        console.warn(`[bus-mirror] drain: event retry cap reached on ${entry.table} — discarding entry`);
        countDiscarded++;
        continue;
      }

      try {
        await postgrestUpsert(entry.table, entry.row);
        countProcessed++;
      } catch (err) {
        if (err instanceof PostgRESTError && err.isPermanent) {
          // Permanent error (400/403/422): re-queuing will never succeed — discard.
          console.error(`[bus-mirror] drain: permanent HTTP ${err.status} on ${entry.table} — discarding entry (will not retry): ${err.message}`);
          countDiscarded++;
        } else {
          console.error(`[bus-mirror] drain: ${entry.table} upsert failed — will re-queue: ${err instanceof Error ? err.message : String(err)}`);
          // Decrement retries_remaining for event entries; leave undefined for tasks/messages.
          const requeueEntry: RetryEntry = entry.retries_remaining !== undefined
            ? { ...entry, retries_remaining: entry.retries_remaining - 1 }
            : entry;
          failed.push(requeueEntry);
        }
      }
    }

    const countFailed = failed.length;
    console.log(
      `[bus-mirror] drain complete: queued=${entries.length} pushed=${countProcessed} requeued=${countFailed} discarded=${countDiscarded}`,
    );

    if (failed.length === 0) {
      clearRetryQueue(qPath);
    } else {
      try {
        writeFileSync(
          qPath,
          failed.map(e => JSON.stringify(e)).join('\n') + '\n',
          { encoding: 'utf-8', mode: 0o600 },
        );
      } catch { /* best-effort */ }
    }
  } finally {
    draining = false;
  }
}

// Reset the drain lock — exported for tests only
export function _resetDrainLock(): void {
  draining = false;
}

// ---------------------------------------------------------------------------
// One-shot migration: remap raw bus constraint values in the retry queue
// ---------------------------------------------------------------------------

// Valid RGOS enum values — anything outside these sets needs remapping.
const RGOS_VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const RGOS_VALID_STATUSES = new Set(['proposed', 'approved', 'in_progress', 'completed', 'cancelled', 'blocked', 'review']);

/**
 * Migrates any orch_tasks retry queue entries whose priority or status still
 * carry raw bus values (e.g. priority="normal", status="pending") that RGOS
 * rejects with a constraint violation.  Idempotent — entries already holding
 * valid RGOS enum values are untouched.
 *
 * Called automatically at the start of drainRetryQueue alongside
 * migrateRetryQueueIds so stale queued entries are transparently upgraded
 * before the next upsert attempt.
 */
export function migrateRetryQueueConstraints(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    if (entry.table !== 'orch_tasks') return entry;

    const priority = entry.row.priority as string | undefined;
    const status = entry.row.status as string | undefined;

    const needsPriority = priority !== undefined && !RGOS_VALID_PRIORITIES.has(priority);
    const needsStatus = status !== undefined && !RGOS_VALID_STATUSES.has(status);

    if (!needsPriority && !needsStatus) return entry;

    changed = true;
    const newRow = { ...entry.row };
    if (needsPriority) newRow.priority = mapPriority(priority!);
    if (needsStatus) newRow.status = mapStatus(status!);
    return { ...entry, row: newRow };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// One-shot migration: rewrite old bus-format IDs in the retry queue to UUIDv5
// ---------------------------------------------------------------------------

/**
 * Migrates any retry queue entries that still carry raw bus IDs (non-UUID) in
 * their row.id field.  Idempotent — entries already holding a UUID are skipped.
 * Adds bus_task_id / bus_message_id to metadata/payload so the original bus ID
 * is not lost.
 *
 * Called automatically at the start of drainRetryQueue so old queued entries
 * are transparently upgraded before the next upsert attempt.
 */
export function migrateRetryQueueIds(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    const id = entry.row.id as string | undefined;
    if (!id || isUuid(id)) return entry; // already a UUID or missing — skip

    changed = true;
    const newId = uuidv5(id);
    const newRow = { ...entry.row, id: newId } as Record<string, unknown>;

    if (entry.table === 'orch_tasks') {
      const meta = (newRow['metadata'] as Record<string, unknown> | undefined) ?? {};
      newRow['metadata'] = { bus_task_id: id, ...meta };
    } else {
      // cortex_messages: bus_message_id goes in payload
      const payload = (newRow['payload'] as Record<string, unknown> | undefined) ?? {};
      newRow['payload'] = { bus_message_id: id, ...payload };
    }

    return { ...entry, row: newRow };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

/**
 * Migrates cortex_messages retry entries whose reply_to_id is a raw bus ID
 * (non-UUID) to UUIDv5, matching buildMessageRow's behavior.
 * Idempotent — entries with UUID or null reply_to_id are untouched.
 */
export function migrateRetryQueueReplyToId(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    if (entry.table !== 'cortex_messages') return entry;
    const replyToId = entry.row.reply_to_id as string | null | undefined;
    if (!replyToId || isUuid(replyToId)) return entry; // already UUID or null — skip

    changed = true;
    return { ...entry, row: { ...entry.row, reply_to_id: uuidv5(replyToId) } };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Constraint maps — translate bus values to RGOS enum values
// ---------------------------------------------------------------------------

// RGOS orch_tasks.priority accepts: low | medium | high
const PRIORITY_MAP: Record<string, string> = {
  low: 'low',
  normal: 'medium',
  high: 'high',
  urgent: 'high',
};

// RGOS orch_tasks.status accepts: proposed | approved | in_progress | completed | cancelled | blocked | review
// Bus `pending` maps to `proposed` (not `approved`) so Hub can distinguish newly-created
// tasks from explicitly approved ones. Reverse sync maps `proposed` → `pending` in bus.
const STATUS_MAP: Record<string, string> = {
  pending: 'proposed',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
  blocked: 'blocked',
  review: 'review',
};

export function mapPriority(p: string): string {
  return PRIORITY_MAP[p] ?? 'medium';
}

export function mapStatus(s: string): string {
  return STATUS_MAP[s] ?? 'approved';
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function buildTaskRow(task: Task): Record<string, unknown> {
  return {
    id: uuidv5(task.id),
    org_id: ORG_ID,
    title: task.title,
    description: task.description || null,
    status: mapStatus(task.status),
    priority: mapPriority(task.priority),
    assigned_to: task.assigned_to,
    created_by: task.created_by,
    parent_task_id: null,
    result: task.result ?? null,
    result_links: null,
    goal_ancestry: null,
    blocked_by: task.blocked_by && task.blocked_by.length > 0 ? task.blocked_by : null,
    tokens_cost: null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at ?? null,
    due_date: task.due_date ?? null,
    project_id: null,
    metadata: {
      bus_task_id: task.id,
      org: task.org,
      project: task.project || null,
      meta: task.meta ?? null,
      blocked_by: task.blocked_by ?? [],
      blocks: task.blocks ?? [],
      kpi_key: task.kpi_key,
      type: task.type,
      needs_approval: task.needs_approval,
    },
    source: MIRROR_SOURCE,
    source_thread_ref: null,
  };
}

export function buildMessageRow(msg: InboxMessage): Record<string, unknown> {
  return {
    id: uuidv5(msg.id),
    org_id: ORG_ID,
    from_agent: msg.from,
    to_agent: msg.to,
    message_type: 'agent_message',
    subject: null,
    body: msg.text,
    payload: {
      bus_message_id: msg.id,
      priority: msg.priority,
      ...(msg.trace_id ? { trace_id: msg.trace_id } : {}),
    },
    thread_id: msg.trace_id ?? null,
    reply_to_id: msg.reply_to ? uuidv5(msg.reply_to) : null,
    read_at: null,
    created_at: msg.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mirror a task write to Supabase orch_tasks. Fire-and-forget — never awaited
 * by callers. Failures queue to JSONL retry, drained on next success.
 */
export async function mirrorTaskToRgos(
  task: Task,
  _event: 'create' | 'update' | 'complete',
): Promise<void> {
  if (!isEnabled()) return;
  const row = buildTaskRow(task);
  try {
    await postgrestUpsert('orch_tasks', row);
    // Async drain: never await, never block the write path
    setImmediate(() => drainRetryQueue().catch(err => escalateCritical('bus-mirror drain loop (task)', err, { queue: 'tasks' })));
  } catch (err) {
    if (err instanceof PostgRESTError && err.isPermanent) {
      console.error(`[bus-mirror] orch_tasks upsert permanent error (HTTP ${err.status}) — discarding (will not retry): ${err.message}`);
    } else {
      console.warn(`[bus-mirror] orch_tasks upsert failed — queuing for retry: ${err instanceof Error ? err.message : String(err)}`);
      enqueueRetry({ table: 'orch_tasks', row, ts: new Date().toISOString() });
    }
  }
}

/**
 * Mirror a message write to Supabase cortex_messages. Fire-and-forget.
 */
export async function mirrorMessageToRgos(msg: InboxMessage): Promise<void> {
  if (!isEnabled()) return;
  const row = buildMessageRow(msg);
  try {
    await postgrestUpsert('cortex_messages', row);
    setImmediate(() => drainRetryQueue().catch(err => escalateCritical('bus-mirror drain loop (message)', err, { queue: 'messages' })));
  } catch (err) {
    if (err instanceof PostgRESTError && err.isPermanent) {
      console.error(`[bus-mirror] cortex_messages upsert permanent error (HTTP ${err.status}) — discarding (will not retry): ${err.message}`);
    } else {
      console.warn(`[bus-mirror] cortex_messages upsert failed — queuing for retry: ${err instanceof Error ? err.message : String(err)}`);
      enqueueRetry({ table: 'cortex_messages', row, ts: new Date().toISOString() });
    }
  }
}

/**
 * Mirror a bus log-event call to Supabase orch_events. Fire-and-forget.
 * Events are observability data — lower durability priority than tasks/messages.
 * Retry cap: EVENT_RETRY_MAX (3) so stale events do not clog the queue on outages.
 */
export async function mirrorEventToRgos(event: {
  id: string;
  agent: string;
  org: string;
  timestamp: string;
  category: string;
  event: string;
  severity: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!isEnabled()) return;
  // ID unification: accept both RGOS UUIDs (passthrough) and raw bus task IDs
  // (convert to the same uuidv5 the task row uses) so orch_events.task_id always
  // resolves to the canonical RGOS UUID for the task, enabling drawer history lookups.
  const rawTaskId = event.metadata.task_id;
  const taskId =
    typeof rawTaskId === 'string' && rawTaskId.length > 0
      ? (isUuid(rawTaskId) ? rawTaskId : uuidv5(rawTaskId))
      : null;
  const row = {
    id: uuidv5(event.id),
    org_id: ORG_ID,
    event_type: event.category,
    agent_id: event.agent,
    task_id: taskId,
    message: event.event,
    metadata: { ...event.metadata, category: event.category, bus_event: event.event },
  };
  try {
    await postgrestUpsert('orch_events', row);
    setImmediate(() => drainRetryQueue().catch(err => escalateCritical('bus-mirror drain loop (event)', err, { queue: 'events' })));
  } catch (err) {
    if (err instanceof PostgRESTError && err.isPermanent) {
      console.error(`[bus-mirror] orch_events upsert permanent error (HTTP ${err.status}) — discarding: ${err.message}`);
    } else {
      console.warn(`[bus-mirror] orch_events upsert failed — queuing for retry: ${err instanceof Error ? err.message : String(err)}`);
      enqueueRetry({ table: 'orch_events', row, ts: new Date().toISOString(), retries_remaining: EVENT_RETRY_MAX });
    }
  }
}
