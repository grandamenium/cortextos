/**
 * human-blockers-digest — G4 autonomy-gaps feature
 *
 * Scans all cortextOS task stores and the pending-approvals store for items
 * that require human attention, then formats them as a compact Telegram
 * digest grouped by priority then by agent.
 *
 * Exported API:
 *   digestHumanBlockers(opts) → Promise<string>   (the digest text)
 *   sendHumanBlockersDigest(opts) → Promise<void> (digest + Telegram send)
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Task, Priority, Approval } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestOptions {
  /** Telegram chat ID to send the digest to. */
  chatId: string;
  /** cortextOS instance ID (default: 'default'). */
  instanceId?: string;
  /** Only include tasks/approvals created after this ISO timestamp. */
  since?: string;
  /** Print to stdout instead of sending Telegram. */
  dryRun?: boolean;
  /** BOT_TOKEN for the Telegram send. Falls back to process.env.BOT_TOKEN. */
  botToken?: string;
}

interface BlockerEntry {
  agent: string;
  priority: Priority;
  summary: string;
  createdAt: string;
  /** Step-by-step copy-pastable details (exact URLs, buttons, fields, paste-back format). */
  details?: string;
}

// ---------------------------------------------------------------------------
// Task scanning
// ---------------------------------------------------------------------------

const HUMAN_TASK_STATUSES = new Set(['pending', 'in_progress', 'approved']);

/**
 * Read all tasks from a task directory that match the [HUMAN] prefix and are
 * in an actionable status.
 */
function scanTaskDir(taskDir: string, since?: Date): BlockerEntry[] {
  if (!existsSync(taskDir)) return [];

  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      (f) => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const entries: BlockerEntry[] = [];
  for (const file of files) {
    try {
      const task: Task = JSON.parse(readFileSync(join(taskDir, file), 'utf-8'));
      if (!task.title.startsWith('[HUMAN]')) continue;
      if (task.archived) continue;
      if (!HUMAN_TASK_STATUSES.has(task.status)) continue;
      if (since && new Date(task.created_at) < since) continue;

      // Strip the [HUMAN] prefix from summary
      const summary = task.title.replace(/^\[HUMAN\]\s*/, '').trim();

      entries.push({
        agent: task.assigned_to || task.created_by || 'unknown',
        priority: task.priority,
        summary: `[task] ${summary}`,
        createdAt: task.created_at,
        details: task.description?.trim() || undefined,
      });
    } catch {
      // Skip corrupt files
    }
  }
  return entries;
}

/**
 * Walk all org task directories under ctxRoot.
 */
function scanAllTasks(ctxRoot: string, since?: Date): BlockerEntry[] {
  const results: BlockerEntry[] = [];

  // Instance-root tasks (no org)
  results.push(...scanTaskDir(join(ctxRoot, 'tasks'), since));

  // Org-scoped tasks
  const orgsDir = join(ctxRoot, 'orgs');
  if (existsSync(orgsDir)) {
    let orgs: string[];
    try {
      orgs = readdirSync(orgsDir);
    } catch {
      orgs = [];
    }
    for (const org of orgs) {
      results.push(...scanTaskDir(join(orgsDir, org, 'tasks'), since));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Approval scanning
// ---------------------------------------------------------------------------

/**
 * Read all pending approvals where decision is null/empty.
 */
function scanPendingApprovals(ctxRoot: string, since?: Date): BlockerEntry[] {
  const entries: BlockerEntry[] = [];
  const orgsDir = join(ctxRoot, 'orgs');
  if (!existsSync(orgsDir)) return entries;

  let orgs: string[];
  try {
    orgs = readdirSync(orgsDir);
  } catch {
    return entries;
  }

  for (const org of orgs) {
    const pendingDir = join(orgsDir, org, 'approvals', 'pending');
    if (!existsSync(pendingDir)) continue;

    let files: string[];
    try {
      files = readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    // Resolved dir — used to filter stale orphan pending files
    const resolvedDir = join(orgsDir, org, 'approvals', 'resolved');

    for (const file of files) {
      // Skip stale orphans: also in resolved/
      if (existsSync(join(resolvedDir, file))) continue;

      try {
        const approval: Approval = JSON.parse(
          readFileSync(join(pendingDir, file), 'utf-8'),
        );
        // Only include un-decided approvals
        if (approval.status && approval.status !== 'pending') continue;
        if (since && new Date(approval.created_at) < since) continue;

        entries.push({
          agent: approval.requesting_agent || 'unknown',
          priority: 'high', // approvals are always treated as high-priority blockers
          summary: `[approval] ${approval.title}`,
          createdAt: approval.created_at,
          details: (approval as unknown as Record<string, unknown>).description as string | undefined,
        });
      } catch {
        // Skip corrupt
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'normal', 'low'];
void PRIORITY_ORDER;

const DETAILS_MAX_CHARS = 600;

/**
 * Truncate details to a readable length and indent each line for Telegram.
 */
function formatDetails(details: string): string {
  const trimmed = details.length > DETAILS_MAX_CHARS
    ? details.slice(0, DETAILS_MAX_CHARS) + '…'
    : details;
  return trimmed
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

/**
 * Group entries by priority then by agent, sort within each group by
 * created_at ASC (oldest blocker first = most urgent to resolve), and
 * format a Telegram-compatible message with step-by-step details per entry.
 */
function formatDigest(entries: BlockerEntry[]): string {
  if (entries.length === 0) {
    return 'No human blockers pending.';
  }

  // Sort by priority rank then created_at
  const sorted = [...entries].sort((a, b) => {
    const pDiff = PRIORITY_MAP[a.priority] - PRIORITY_MAP[b.priority];
    if (pDiff !== 0) return pDiff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const lines: string[] = [`*Human blockers digest* (${entries.length} item${entries.length === 1 ? '' : 's'})`];

  let currentPriority: Priority | null = null;
  for (const entry of sorted) {
    if (entry.priority !== currentPriority) {
      currentPriority = entry.priority;
      const label = currentPriority.toUpperCase();
      lines.push(`\n[${label}]`);
    }
    // Header line: agent: summary
    lines.push(`  ${entry.agent}: ${entry.summary}`);
    // Step-by-step details block (exact URL, buttons, fields, paste-back format)
    if (entry.details) {
      lines.push(formatDetails(entry.details));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the human-blockers digest string without sending it.
 *
 * @param opts.instanceId  cortextOS instance ID (default: 'default')
 * @param opts.since       ISO timestamp — only include items created after this
 */
export function digestHumanBlockers(opts: {
  instanceId?: string;
  since?: string;
  chatId?: string;
}): string {
  const instanceId = opts.instanceId || process.env.CTX_INSTANCE_ID || 'default';
  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const since = opts.since ? new Date(opts.since) : undefined;

  const taskEntries = scanAllTasks(ctxRoot, since);
  const approvalEntries = scanPendingApprovals(ctxRoot, since);
  const all = [...taskEntries, ...approvalEntries];

  return formatDigest(all);
}

/**
 * Build the digest and either send it to Telegram or print to stdout.
 *
 * Resolves the BOT_TOKEN in this order:
 *   1. opts.botToken
 *   2. process.env.BOT_TOKEN
 *
 * @throws Error when Telegram send fails (non-dry-run mode)
 */
export async function sendHumanBlockersDigest(opts: DigestOptions): Promise<void> {
  const digest = digestHumanBlockers({
    instanceId: opts.instanceId,
    since: opts.since,
    chatId: opts.chatId,
  });

  if (opts.dryRun) {
    process.stdout.write(digest + '\n');
    return;
  }

  const botToken = opts.botToken || process.env.BOT_TOKEN || '';
  if (!botToken) {
    throw new Error(
      'human-blockers-digest: BOT_TOKEN not set. Pass --bot-token or set BOT_TOKEN in env.',
    );
  }

  const api = new TelegramAPI(botToken);
  await api.sendMessage(opts.chatId, digest, undefined, { parseMode: null });
}
