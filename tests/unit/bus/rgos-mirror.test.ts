/**
 * Unit tests for src/bus/rgos-mirror.ts
 *
 * Covers all 10 plan scenarios + concurrent drain lock + UUID migration:
 * 1. mirrorTaskToRgos fires and payload shape is correct
 * 2. Status transitions (update) mirror correctly
 * 3. Completion + result field mirrored
 * 4. mirrorMessageToRgos fires and payload shape is correct
 * 5. Kill switch BUS_RGOS_MIRROR_DISABLED=1 → no fetch
 * 6. Missing SUPABASE_RGOS_URL → no fetch
 * 7. Missing SUPABASE_RGOS_SERVICE_KEY → no fetch
 * 8. Network failure → retry enqueue → entry written to JSONL
 * 9. Retry drain on success → queued items flushed
 * 10. Retry queue FIFO eviction at 500 entries
 * 11. Concurrent drain lock → second call returns immediately
 * 12. UUIDv5 determinism and format
 * 13. Retry queue migration (bus IDs → UUIDv5)
 * 14. Replay / PostgREST UUID validation
 *
 * Strategy: vi.stubGlobal('fetch') to intercept all HTTP without real network.
 * Temp dirs for retry queue file assertions.
 * Env vars set/unset in beforeEach/afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Imports from module under test ──────────────────────────────────────────

import {
  mirrorTaskToRgos,
  mirrorMessageToRgos,
  mirrorEventToRgos,
  broadcastPresence,
  drainRetryQueue,
  enqueueRetry,
  readRetryQueue,
  buildTaskRow,
  buildMessageRow,
  isEnabled,
  uuidv5,
  isUuid,
  migrateRetryQueueIds,
  mapPriority,
  mapStatus,
  migrateRetryQueueConstraints,
  migrateRetryQueueReplyToId,
  PostgRESTError,
  _resetDrainLock,
} from '../../../src/bus/rgos-mirror.js';
import type { Task, InboxMessage } from '../../../src/types/index.js';

// ── UUID regex — v5 specifically ─────────────────────────────────────────────

const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1234567890_001',
    title: 'Test task',
    description: 'A test task',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'dev',
    created_by: 'orchestrator',
    org: 'revops-global',
    priority: 'normal',
    project: 'test-project',
    kpi_key: null,
    created_at: '2026-04-25T10:00:00Z',
    updated_at: '2026-04-25T10:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 'msg_test_001',
    from: 'orchestrator',
    to: 'dev',
    priority: 'normal',
    timestamp: '2026-04-25T10:00:00.000Z',
    text: 'Hello from orchestrator',
    reply_to: null,
    ...overrides,
  };
}

// ── Env setup helpers ────────────────────────────────────────────────────────

function setMirrorEnv(tmpDir: string) {
  process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
  process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
  process.env.CTX_ROOT = tmpDir;
  process.env.CTX_AGENT_NAME = 'dev';
  delete process.env.BUS_RGOS_MIRROR_DISABLED;
}

function clearMirrorEnv() {
  delete process.env.SUPABASE_RGOS_URL;
  delete process.env.SUPABASE_RGOS_SERVICE_KEY;
  delete process.env.CTX_ROOT;
  delete process.env.CTX_AGENT_NAME;
  delete process.env.BUS_RGOS_MIRROR_DISABLED;
}

// ── Mock fetch helper ────────────────────────────────────────────────────────

function mockFetchOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    text: async () => '',
  }));
}

function mockFetchFail(msg = 'Network error') {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(msg)));
}

function mockFetchHttpError(status = 500, body = 'Internal Server Error') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rgos-mirror — isEnabled()', () => {
  afterEach(() => { clearMirrorEnv(); });

  it('returns true when all required env vars are set', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    expect(isEnabled()).toBe(true);
  });

  it('returns false when BUS_RGOS_MIRROR_DISABLED=1', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';
    expect(isEnabled()).toBe(false);
  });

  it('returns false when SUPABASE_RGOS_URL missing', () => {
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    expect(isEnabled()).toBe(false);
  });

  it('returns false when SUPABASE_RGOS_SERVICE_KEY missing', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    expect(isEnabled()).toBe(false);
  });
});

describe('rgos-mirror — uuidv5() and isUuid()', () => {
  it('produces a valid UUIDv5 string (version byte = 5, variant = 8-9-a-b)', () => {
    const result = uuidv5('task_1234567890_001');
    expect(result).toMatch(UUID_V5_RE);
  });

  it('is deterministic — same input always yields same output', () => {
    const a = uuidv5('task_1234567890_001');
    const b = uuidv5('task_1234567890_001');
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different inputs', () => {
    const a = uuidv5('task_1234567890_001');
    const b = uuidv5('task_1234567890_002');
    expect(a).not.toBe(b);
  });

  it('works on message ID format', () => {
    const result = uuidv5('1777129008288-dev-9kims');
    expect(result).toMatch(UUID_V5_RE);
  });

  it('isUuid returns true for a valid UUID', () => {
    expect(isUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    expect(isUuid(uuidv5('anything'))).toBe(true);
  });

  it('isUuid returns false for bus-format IDs', () => {
    expect(isUuid('task_1234567890_001')).toBe(false);
    expect(isUuid('1777129008288-dev-9kims')).toBe(false);
    expect(isUuid('msg_test_001')).toBe(false);
  });
});

describe('rgos-mirror — buildTaskRow()', () => {
  it('row.id is a UUIDv5 derived from the bus task ID', () => {
    const task = makeTask();
    const row = buildTaskRow(task);
    expect(row.id).toMatch(UUID_V5_RE);
    expect(row.id).toBe(uuidv5(task.id));
  });

  it('metadata.bus_task_id preserves the original bus ID', () => {
    const task = makeTask();
    const row = buildTaskRow(task);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.bus_task_id).toBe(task.id);
  });

  it('maps other required fields correctly', () => {
    const task = makeTask();
    const row = buildTaskRow(task);
    expect(row.org_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.title).toBe(task.title);
    expect(row.status).toBe('proposed'); // pending → proposed via STATUS_MAP
    expect(row.priority).toBe('medium'); // normal → medium via PRIORITY_MAP
    expect(row.assigned_to).toBe('dev');
    expect(row.created_by).toBe('orchestrator');
    expect(row.source).toBe('cortextos_bus_mirror');
  });

  it('maps result field when present', () => {
    const task = makeTask({ status: 'completed', result: 'Done successfully', completed_at: '2026-04-25T11:00:00Z' });
    const row = buildTaskRow(task);
    expect(row.result).toBe('Done successfully');
    expect(row.completed_at).toBe('2026-04-25T11:00:00Z');
  });

  it('includes metadata with org, project, blocked_by, blocks', () => {
    const task = makeTask({ blocked_by: ['task_abc'], blocks: ['task_xyz'] });
    const row = buildTaskRow(task);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.org).toBe('revops-global');
    expect(meta.project).toBe('test-project');
    expect(meta.blocked_by).toEqual(['task_abc']);
    expect(meta.blocks).toEqual(['task_xyz']);
  });

  it('sets null for optional fields when absent', () => {
    const task = makeTask();
    const row = buildTaskRow(task);
    expect(row.result).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.due_date).toBeNull();
    expect(row.parent_task_id).toBeNull();
    expect(row.project_id).toBeNull();
    expect(row.source_thread_ref).toBeNull();
  });
});

describe('rgos-mirror — buildMessageRow()', () => {
  it('row.id is a UUIDv5 derived from the bus message ID', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);
    expect(row.id).toMatch(UUID_V5_RE);
    expect(row.id).toBe(uuidv5(msg.id));
  });

  it('payload.bus_message_id preserves the original bus ID', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.bus_message_id).toBe(msg.id);
  });

  it('maps other required fields correctly', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);
    expect(row.org_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.from_agent).toBe('orchestrator');
    expect(row.to_agent).toBe('dev');
    expect(row.message_type).toBe('agent_message');
    expect(row.body).toBe('Hello from orchestrator');
    expect(row.reply_to_id).toBeNull();
    expect(row.read_at).toBeNull();
  });

  it('maps trace_id to thread_id when present', () => {
    const msg = makeMessage({ trace_id: 'trace-abc-123' });
    const row = buildMessageRow(msg);
    expect(row.thread_id).toBe('trace-abc-123');
    expect((row.payload as Record<string, unknown>).trace_id).toBe('trace-abc-123');
  });

  it('maps reply_to to reply_to_id as UUIDv5', () => {
    const msg = makeMessage({ reply_to: 'msg_original_001' });
    const row = buildMessageRow(msg);
    expect(isUuid(row.reply_to_id as string)).toBe(true);
    expect(row.reply_to_id).toBe(uuidv5('msg_original_001'));
  });

  it('sets reply_to_id to null when reply_to is null', () => {
    const msg = makeMessage({ reply_to: null });
    const row = buildMessageRow(msg);
    expect(row.reply_to_id).toBeNull();
  });

  it('sets thread_id to null when no trace_id', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);
    expect(row.thread_id).toBeNull();
  });
});

// ── Scenario 1-3: mirrorTaskToRgos ──────────────────────────────────────────

describe('rgos-mirror — mirrorTaskToRgos (scenario 1-3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mockFetchOk();
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires fetch with correct endpoint and headers on create', async () => {
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/orch_tasks');
    expect((opts?.headers as Record<string, string>)['apikey']).toBe('test-service-key');
    expect((opts?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-service-key');
    expect((opts?.headers as Record<string, string>)['Prefer']).toBe('resolution=merge-duplicates');
  });

  it('sends UUIDv5 id and correct payload for createTask (scenario 1)', async () => {
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const mockFetch = vi.mocked(fetch);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts?.body as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.id).toBe(uuidv5(task.id));
    expect(body.status).toBe('proposed'); // pending → proposed via STATUS_MAP
    expect(body.priority).toBe('medium'); // normal → medium via PRIORITY_MAP
    expect(body.source).toBe('cortextos_bus_mirror');
    expect(body.metadata.bus_task_id).toBe(task.id);
  });

  it('mirrors status transition for updateTask (scenario 2)', async () => {
    const task = makeTask({ status: 'in_progress', updated_at: '2026-04-25T10:30:00Z' });
    await mirrorTaskToRgos(task, 'update');

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.status).toBe('in_progress');
    expect(body.updated_at).toBe('2026-04-25T10:30:00Z');
  });

  it('mirrors completion + result for completeTask (scenario 3)', async () => {
    const task = makeTask({
      status: 'completed',
      result: 'Shipped the feature',
      completed_at: '2026-04-25T11:00:00Z',
    });
    await mirrorTaskToRgos(task, 'complete');

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.status).toBe('completed');
    expect(body.result).toBe('Shipped the feature');
    expect(body.completed_at).toBe('2026-04-25T11:00:00Z');
  });
});

describe('rgos-mirror — broadcastPresence (STACK-11)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-presence-test-'));
    setMirrorEnv(tmpDir);
    mockFetchOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('posts the realtime presence broadcast contract', async () => {
    const payload = {
      actor_id: 'codex',
      kind: 'agent' as const,
      name: 'codex',
      avatar_url: null,
      task_id: 'task_123',
      task_title: 'Task title',
      status: 'task_updated' as const,
      action_label: 'Working: task',
      updated_at: '2026-05-18T19:15:00.000Z',
      source: 'cortextos-bus' as const,
    };

    await broadcastPresence(payload);

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/realtime/v1/api/broadcast');
    expect((opts?.headers as Record<string, string>)['apikey']).toBe('test-service-key');
    expect((opts?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-service-key');
    expect(JSON.parse(opts?.body as string)).toEqual({
      messages: [{ topic: 'agent-presence', event: 'presence_update', payload }],
    });
  });

  it('keeps presence best-effort and does not enqueue retries on failure', async () => {
    mockFetchFail('realtime offline');

    await expect(broadcastPresence({
      actor_id: 'codex',
      kind: 'agent',
      name: 'codex',
      avatar_url: null,
      task_id: null,
      task_title: null,
      status: 'idle',
      action_label: null,
      updated_at: '2026-05-18T19:15:00.000Z',
      source: 'cortextos-bus',
    })).resolves.toBeUndefined();

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });
});

// ── Scenario 4: mirrorMessageToRgos ─────────────────────────────────────────

describe('rgos-mirror — mirrorMessageToRgos (scenario 4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mockFetchOk();
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires fetch with correct endpoint for sendMessage (scenario 4)', async () => {
    const msg = makeMessage();
    await mirrorMessageToRgos(msg);

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/cortex_messages');
  });

  it('sends UUIDv5 id and correct payload for mirrorMessageToRgos', async () => {
    const msg = makeMessage({ trace_id: 'trace-xyz', reply_to: 'msg_parent' });
    await mirrorMessageToRgos(msg);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.id).toBe(uuidv5(msg.id));
    expect(body.from_agent).toBe('orchestrator');
    expect(body.to_agent).toBe('dev');
    expect(body.body).toBe('Hello from orchestrator');
    expect(body.thread_id).toBe('trace-xyz');
    expect(body.reply_to_id).toBe(uuidv5('msg_parent'));
    expect(body.payload.bus_message_id).toBe(msg.id);
    expect(body.source).toBeUndefined(); // messages don't have source
  });
});

// ── Scenarios 5-7: Kill switch + missing env ─────────────────────────────────

describe('rgos-mirror — kill switch and missing env (scenarios 5-7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    mockFetchOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when BUS_RGOS_MIRROR_DISABLED=1 (scenario 5)', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when SUPABASE_RGOS_URL missing (scenario 6)', async () => {
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when SUPABASE_RGOS_SERVICE_KEY missing (scenario 7)', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops mirrorMessageToRgos when kill switch is on', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';

    await mirrorMessageToRgos(makeMessage());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── Scenario 8: Network failure → retry enqueue ──────────────────────────────

describe('rgos-mirror — network failure → retry enqueue (scenario 8)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueues to retry.jsonl when fetch throws (scenario 8)', async () => {
    mockFetchFail('ECONNRESET');

    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(true);
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('orch_tasks');
    // row.id must now be a UUIDv5
    expect(entries[0].row.id as string).toMatch(UUID_V5_RE);
    expect(entries[0].row.id).toBe(uuidv5(task.id));
    // original bus ID preserved in metadata
    expect((entries[0].row.metadata as Record<string, unknown>).bus_task_id).toBe(task.id);
    expect(entries[0].ts).toBeDefined();
  });

  it('enqueues to retry.jsonl when HTTP 500 returned', async () => {
    mockFetchHttpError(500, 'DB overloaded');

    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('orch_tasks');
    expect(entries[0].row.id as string).toMatch(UUID_V5_RE);
  });

  it('enqueues message to retry.jsonl when fetch fails', async () => {
    mockFetchFail('Network unreachable');

    const msg = makeMessage();
    await mirrorMessageToRgos(msg);

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('cortex_messages');
    expect(entries[0].row.id as string).toMatch(UUID_V5_RE);
    expect((entries[0].row.payload as Record<string, unknown>).bus_message_id).toBe(msg.id);
  });
});

// ── Scenario 9: Retry drain on success ──────────────────────────────────────

describe('rgos-mirror — retry drain on success (scenario 9)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drains queued entries when fetch succeeds (scenario 9)', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    // Pre-populate retry queue with 3 entries (already UUID format — simulating migrated entries)
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_001') }, ts: '2026-04-25T09:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_002') }, ts: '2026-04-25T09:01:00Z' });
    enqueueRetry({ table: 'cortex_messages', row: { id: uuidv5('msg_001') }, ts: '2026-04-25T09:02:00Z' });
    expect(readRetryQueue(qPath)).toHaveLength(3);

    mockFetchOk();
    await drainRetryQueue();

    // All entries should be cleared
    expect(readRetryQueue(qPath)).toHaveLength(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('leaves only failed entries after partial drain', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_will_succeed') }, ts: '2026-04-25T09:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_will_fail') }, ts: '2026-04-25T09:01:00Z' });

    // First call succeeds, second fails
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockRejectedValueOnce(new Error('DB timeout')),
    );

    await drainRetryQueue();

    const remaining = readRetryQueue(qPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].row.id).toBe(uuidv5('task_will_fail'));
  });

  it('no-ops drain when retry queue is empty', async () => {
    mockFetchOk();
    await drainRetryQueue();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── Scenario 10: FIFO eviction at 500 entries ────────────────────────────────

describe('rgos-mirror — FIFO eviction at 500 entries (scenario 10)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps queue at 500 and drops oldest entries (scenario 10)', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    // Pre-populate 500 entries (the max)
    for (let i = 0; i < 500; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i.toString().padStart(4, '0')}` }, ts: '2026-04-25T09:00:00Z' });
    }
    expect(readRetryQueue(qPath)).toHaveLength(500);

    // Adding one more should evict the oldest
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_overflow' }, ts: '2026-04-25T09:00:00Z' });

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(500);
    // The oldest entry (task_0000) should be evicted
    expect(entries[0].row.id).toBe('task_0001');
    // The new entry should be at the end
    expect(entries[entries.length - 1].row.id).toBe('task_overflow');
  });

  it('does not crash when adding to a nearly full queue', () => {
    // Fill to 498
    for (let i = 0; i < 498; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i}` }, ts: '2026-04-25T09:00:00Z' });
    }
    // Add 5 more — should cap at 500, no crash
    for (let i = 498; i < 503; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i}` }, ts: '2026-04-25T09:00:00Z' });
    }
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(readRetryQueue(qPath)).toHaveLength(500);
  });
});

// ── Scenario 11: Concurrent drain lock ──────────────────────────────────────

describe('rgos-mirror — concurrent drain lock (scenario 11)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
    _resetDrainLock();
  });

  it('second concurrent drain returns immediately without calling fetch again (scenario 11)', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_001') }, ts: '2026-04-25T09:00:00Z' });

    // Slow fetch — drain1 will hold the lock during its await
    let resolveFirst!: () => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<{ ok: boolean; text: () => Promise<string> }>((resolve) => {
        resolveFirst = () => resolve({ ok: true, text: async () => '' });
      }))
      .mockResolvedValue({ ok: true, text: async () => '' }),
    );

    // Start drain1 (will hold the lock at the first fetch await)
    const drain1 = drainRetryQueue();

    // Start drain2 immediately — the lock is held, it should no-op
    const drain2 = drainRetryQueue();

    // Resolve drain2 — it should return immediately (lock held)
    await drain2;

    // Fetch should have been called only once so far (by drain1)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    // Unblock drain1
    resolveFirst();
    await drain1;

    // After drain1 finishes, queue should be empty
    expect(readRetryQueue(qPath)).toHaveLength(0);
    // Total fetches = 1 (drain2 was a no-op)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

// ── Retry queue migration (scenario 13) ─────────────────────────────────────

describe('rgos-mirror — migrateRetryQueueIds()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
  });

  afterEach(() => {
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rewrites bus-format task IDs to UUIDv5 and preserves original in metadata', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const oldId = 'task_1777128629875_496';
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: oldId, title: 'Old task', metadata: { org: 'revops-global' } },
      ts: '2026-04-25T14:56:39.125Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueIds();

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.id as string).toMatch(UUID_V5_RE);
    expect(entries[0].row.id).toBe(uuidv5(oldId));
    const meta = entries[0].row.metadata as Record<string, unknown>;
    expect(meta.bus_task_id).toBe(oldId);
    // Other metadata preserved
    expect(meta.org).toBe('revops-global');
  });

  it('rewrites bus-format message IDs to UUIDv5 and preserves original in payload', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const oldId = '1777129008288-dev-9kims';
    const entry = {
      table: 'cortex_messages' as const,
      row: { id: oldId, body: 'hello', payload: { priority: 'normal' } },
      ts: '2026-04-25T14:56:48.485Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueIds();

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.id as string).toMatch(UUID_V5_RE);
    expect(entries[0].row.id).toBe(uuidv5(oldId));
    const payload = entries[0].row.payload as Record<string, unknown>;
    expect(payload.bus_message_id).toBe(oldId);
    expect(payload.priority).toBe('normal');
  });

  it('skips entries that already have a UUID id (idempotent)', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const alreadyUuid = uuidv5('task_001');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: alreadyUuid, metadata: { bus_task_id: 'task_001' } },
      ts: '2026-04-25T14:56:39Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueIds();

    const entries = readRetryQueue(qPath);
    // ID must be unchanged
    expect(entries[0].row.id).toBe(alreadyUuid);
    // bus_task_id must be preserved
    expect((entries[0].row.metadata as Record<string, unknown>).bus_task_id).toBe('task_001');
  });

  it('handles mixed queue with some migrated and some old entries', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const oldTaskId = 'task_1234567890_001';
    const alreadyUuid = uuidv5('task_already_migrated');
    const lines = [
      JSON.stringify({ table: 'orch_tasks', row: { id: oldTaskId }, ts: '2026-04-25T09:00:00Z' }),
      JSON.stringify({ table: 'orch_tasks', row: { id: alreadyUuid }, ts: '2026-04-25T09:01:00Z' }),
    ].join('\n') + '\n';
    writeFileSync(qPath, lines, { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueIds();

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].row.id).toBe(uuidv5(oldTaskId));
    expect(entries[1].row.id).toBe(alreadyUuid);
  });

  it('no-ops when queue is empty', () => {
    // Should not throw
    migrateRetryQueueIds();
  });

  it('migration runs automatically inside drainRetryQueue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const oldId = 'task_legacy_000';
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: oldId },
      ts: '2026-04-25T09:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    _resetDrainLock();

    await drainRetryQueue();

    // The fetch body should contain the UUIDv5 id, not the old bus id
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.id).toBe(uuidv5(oldId));
    vi.unstubAllGlobals();
  });
});

// ── Replay / PostgREST UUID validation (scenario 14) ─────────────────────────

describe('rgos-mirror — PostgREST UUID validation (scenario 14)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('buildTaskRow produces a row.id that passes PostgREST UUID validation', () => {
    // Simulates PostgREST accepting the payload: id must match UUID format
    const task = makeTask({ id: 'task_1777128629875_496' });
    const row = buildTaskRow(task);
    expect(typeof row.id).toBe('string');
    expect(row.id as string).toMatch(UUID_RE);
  });

  it('buildMessageRow produces a row.id that passes PostgREST UUID validation', () => {
    const msg = makeMessage({ id: '1777129008288-dev-9kims' });
    const row = buildMessageRow(msg);
    expect(typeof row.id).toBe('string');
    expect(row.id as string).toMatch(UUID_RE);
  });

  it('upsert payload with bus-format id would have triggered 22P02 — UUIDv5 fixes it', () => {
    // Verify the old format explicitly fails the UUID regex (documenting the root cause)
    const busTaskId = 'task_1777128629875_496';
    const busMessageId = '1777129008288-dev-9kims';
    expect(busTaskId).not.toMatch(UUID_RE);
    expect(busMessageId).not.toMatch(UUID_RE);

    // And confirm the fix produces valid UUIDs
    expect(uuidv5(busTaskId)).toMatch(UUID_RE);
    expect(uuidv5(busMessageId)).toMatch(UUID_RE);
  });

  it('same bus ID always maps to the same UUID (idempotent upsert is safe)', () => {
    const busId = 'task_1234567890_001';
    const uuid1 = uuidv5(busId);
    const uuid2 = uuidv5(busId);
    expect(uuid1).toBe(uuid2);
    expect(uuid1).toMatch(UUID_RE);
  });
});

// ── Priority and status constraint maps ──────────────────────────────────────

const RGOS_VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const RGOS_VALID_STATUSES = new Set(['proposed', 'approved', 'in_progress', 'completed', 'cancelled', 'blocked', 'review']);

describe('rgos-mirror — mapPriority()', () => {
  it('low → low', () => { expect(mapPriority('low')).toBe('low'); });
  it('normal → medium', () => { expect(mapPriority('normal')).toBe('medium'); });
  it('high → high', () => { expect(mapPriority('high')).toBe('high'); });
  it('urgent → high (collapse upward)', () => { expect(mapPriority('urgent')).toBe('high'); });
  it('unknown falls back to medium', () => { expect(mapPriority('whatever')).toBe('medium'); });

  it('all bus priorities map to a valid RGOS priority value', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) {
      expect(RGOS_VALID_PRIORITIES.has(mapPriority(p))).toBe(true);
    }
  });
});

describe('rgos-mirror — mapStatus()', () => {
  it('pending → proposed', () => { expect(mapStatus('pending')).toBe('proposed'); });
  it('in_progress → in_progress', () => { expect(mapStatus('in_progress')).toBe('in_progress'); });
  it('completed → completed', () => { expect(mapStatus('completed')).toBe('completed'); });
  it('cancelled → cancelled', () => { expect(mapStatus('cancelled')).toBe('cancelled'); });
  it('blocked → blocked', () => { expect(mapStatus('blocked')).toBe('blocked'); });
  it('review → review', () => { expect(mapStatus('review')).toBe('review'); });
  it('unknown falls back to approved', () => { expect(mapStatus('whatever')).toBe('approved'); });

  it('all bus statuses map to a valid RGOS status value', () => {
    for (const s of ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'review']) {
      expect(RGOS_VALID_STATUSES.has(mapStatus(s))).toBe(true);
    }
  });
});

describe('rgos-mirror — buildTaskRow() constraint smoke tests', () => {
  it('buildTaskRow always produces a valid RGOS priority', () => {
    for (const priority of ['low', 'normal', 'high', 'urgent']) {
      const row = buildTaskRow(makeTask({ priority }));
      expect(RGOS_VALID_PRIORITIES.has(row.priority as string)).toBe(true);
    }
  });

  it('buildTaskRow always produces a valid RGOS status', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'review'] as const) {
      const row = buildTaskRow(makeTask({ status }));
      expect(RGOS_VALID_STATUSES.has(row.status as string)).toBe(true);
    }
  });

  it('buildTaskRow with bus defaults (pending/normal) produces proposed/medium', () => {
    const row = buildTaskRow(makeTask({ status: 'pending', priority: 'normal' }));
    expect(row.status).toBe('proposed');
    expect(row.priority).toBe('medium');
  });
});

// ── Retry queue constraint migration (scenario 15) ───────────────────────────

describe('rgos-mirror — migrateRetryQueueConstraints()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
  });

  afterEach(() => {
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('remaps priority=normal to medium and status=pending to proposed', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: uuidv5('task_001'), priority: 'normal', status: 'pending', title: 'Old task' },
      ts: '2026-04-25T14:56:39.125Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueConstraints();

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.priority).toBe('medium');
    expect(entries[0].row.status).toBe('proposed');
    // Other fields preserved
    expect(entries[0].row.title).toBe('Old task');
  });

  it('remaps priority=urgent to high', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: uuidv5('task_002'), priority: 'urgent', status: 'in_progress' },
      ts: '2026-04-25T14:56:39.125Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueConstraints();

    const entries = readRetryQueue(qPath);
    expect(entries[0].row.priority).toBe('high');
    expect(entries[0].row.status).toBe('in_progress'); // already valid, untouched
  });

  it('skips entries that already have valid RGOS values (idempotent)', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: uuidv5('task_003'), priority: 'medium', status: 'approved' },
      ts: '2026-04-25T14:56:39.125Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    const before = readFileSync(qPath, 'utf-8');

    migrateRetryQueueConstraints();

    // File should be unchanged (no rewrite happened)
    const after = readFileSync(qPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('does not touch cortex_messages entries', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'cortex_messages' as const,
      row: { id: uuidv5('msg_001'), payload: { priority: 'normal' } },
      ts: '2026-04-25T14:56:39.125Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueConstraints();

    const entries = readRetryQueue(qPath);
    // payload.priority is not remapped — messages don't have top-level priority
    expect((entries[0].row.payload as Record<string, unknown>).priority).toBe('normal');
  });

  it('handles mixed queue — only migrates entries that need it', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const lines = [
      JSON.stringify({ table: 'orch_tasks', row: { id: uuidv5('task_a'), priority: 'normal', status: 'pending' }, ts: '2026-04-25T09:00:00Z' }),
      JSON.stringify({ table: 'orch_tasks', row: { id: uuidv5('task_b'), priority: 'high', status: 'completed' }, ts: '2026-04-25T09:01:00Z' }),
    ].join('\n') + '\n';
    writeFileSync(qPath, lines, { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueConstraints();

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].row.priority).toBe('medium');   // migrated
    expect(entries[0].row.status).toBe('proposed');  // migrated (pending→proposed)
    expect(entries[1].row.priority).toBe('high');    // unchanged
    expect(entries[1].row.status).toBe('completed'); // unchanged
  });

  it('no-ops when queue is empty', () => {
    // Should not throw
    migrateRetryQueueConstraints();
  });

  it('constraint migration runs automatically inside drainRetryQueue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: uuidv5('task_poison'), priority: 'normal', status: 'pending' },
      ts: '2026-04-25T09:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    _resetDrainLock();

    await drainRetryQueue();

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.priority).toBe('medium');
    expect(body.status).toBe('proposed');
    vi.unstubAllGlobals();
  });
});

// ── Retry queue reply_to_id migration (scenario 16) ─────────────────────────

describe('rgos-mirror — migrateRetryQueueReplyToId()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
  });

  afterEach(() => {
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts raw bus reply_to_id to UUIDv5 in cortex_messages entries', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const rawReplyTo = '1777131057931-orchestrator-ojlbs';
    const entry = {
      table: 'cortex_messages' as const,
      row: { id: uuidv5('msg_001'), reply_to_id: rawReplyTo, body: 'test' },
      ts: '2026-04-26T10:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueReplyToId();

    const lines = readFileSync(qPath, 'utf-8').trim().split('\n');
    const migrated = JSON.parse(lines[0]);
    expect(isUuid(migrated.row.reply_to_id)).toBe(true);
    expect(migrated.row.reply_to_id).toBe(uuidv5(rawReplyTo));
  });

  it('leaves already-UUID reply_to_id untouched', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const alreadyUuid = uuidv5('some-msg-id');
    const entry = {
      table: 'cortex_messages' as const,
      row: { id: uuidv5('msg_002'), reply_to_id: alreadyUuid, body: 'test' },
      ts: '2026-04-26T10:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueReplyToId();

    const lines = readFileSync(qPath, 'utf-8').trim().split('\n');
    const result = JSON.parse(lines[0]);
    expect(result.row.reply_to_id).toBe(alreadyUuid);
  });

  it('leaves null reply_to_id untouched', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'cortex_messages' as const,
      row: { id: uuidv5('msg_003'), reply_to_id: null, body: 'test' },
      ts: '2026-04-26T10:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueReplyToId();

    const lines = readFileSync(qPath, 'utf-8').trim().split('\n');
    const result = JSON.parse(lines[0]);
    expect(result.row.reply_to_id).toBeNull();
  });

  it('does not touch orch_tasks entries', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entry = {
      table: 'orch_tasks' as const,
      row: { id: uuidv5('task_001'), reply_to_id: 'raw-bus-id-xyz' },
      ts: '2026-04-26T10:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });

    migrateRetryQueueReplyToId();

    const lines = readFileSync(qPath, 'utf-8').trim().split('\n');
    const result = JSON.parse(lines[0]);
    expect(result.row.reply_to_id).toBe('raw-bus-id-xyz'); // untouched
  });

  it('reply_to_id migration runs automatically inside drainRetryQueue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const rawReplyTo = '1777131057931-orchestrator-ojlbs';
    const entry = {
      table: 'cortex_messages' as const,
      row: {
        id: uuidv5('msg_autorun_test'),
        reply_to_id: rawReplyTo,
        body: 'test auto-run',
        from_agent: 'orchestrator',
        to_agent: 'dev',
        priority: 'normal',
        created_at: '2026-04-26T10:00:00Z',
      },
      ts: '2026-04-26T10:00:00Z',
    };
    writeFileSync(qPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    _resetDrainLock();

    await drainRetryQueue();

    // The fetch body should have a UUIDv5 reply_to_id, not the raw bus ID
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(isUuid(body.reply_to_id)).toBe(true);
    expect(body.reply_to_id).toBe(uuidv5(rawReplyTo));
    vi.unstubAllGlobals();
  });
});

// ── FK retry path ─────────────────────────────────────────────────────────────

describe('rgos-mirror — FK constraint retry (23503)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-fk-'));
    process.env.CTX_ROOT = tmpDir;
    process.env.CTX_AGENT_NAME = 'dev';
    process.env.SUPABASE_RGOS_URL = 'https://fake.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-key';
    delete process.env.BUS_RGOS_MIRROR_DISABLED;
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CTX_ROOT;
    delete process.env.CTX_AGENT_NAME;
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.SUPABASE_RGOS_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  it('retries with reply_to_id=null on 409/23503 FK violation and succeeds', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ url: String(url), body });
      // First call: FK violation
      if (calls.length === 1) {
        return { ok: false, status: 409, text: async () => '{"code":"23503","message":"FK violation"}' };
      }
      // Retry call: succeed
      return { ok: true, status: 201, text: async () => '' };
    });

    const msg = {
      id: 'msg_001',
      from: 'dev',
      to: 'orchestrator',
      priority: 'normal' as const,
      timestamp: '2026-04-26T10:00:00.000Z',
      text: 'hello',
      reply_to: 'msg_parent',
      trace_id: undefined,
    };

    await mirrorMessageToRgos(msg as any);

    expect(calls).toHaveLength(2);
    // First attempt had reply_to_id set
    expect(calls[0].body.reply_to_id).not.toBeNull();
    // Retry had reply_to_id stripped
    expect(calls[1].body.reply_to_id).toBeNull();
    // Nothing queued — retry succeeded
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('enqueues on retry failure after 23503 — does not loop infinitely', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 409,
      text: async () => '{"code":"23503","message":"FK violation"}',
    }));

    const msg = {
      id: 'msg_002',
      from: 'dev',
      to: 'orchestrator',
      priority: 'normal' as const,
      timestamp: '2026-04-26T10:00:00.000Z',
      text: 'hello',
      reply_to: 'msg_parent',
    };

    await mirrorMessageToRgos(msg as any);

    // Should have enqueued — not crashed
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(true);
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
  });

  it('does not retry orch_tasks on 23503 (FK only applies to cortex_messages.reply_to_id)', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push(1);
      return { ok: false, status: 409, text: async () => '{"code":"23503","message":"FK violation"}' };
    });

    const task = {
      id: 'task_001', org: 'test', title: 'T', description: '', status: 'pending',
      priority: 'normal', assigned_to: 'dev', created_by: 'dev',
      created_at: '2026-04-26T10:00:00.000Z', updated_at: '2026-04-26T10:00:00.000Z',
    };

    await mirrorTaskToRgos(task as any, 'create');

    // Only 1 call — no FK retry for orch_tasks
    expect(calls).toHaveLength(1);
  });
});

// ── P2: 4xx permanent error classification (scenario 17) ────────────────────

describe('rgos-mirror — permanent 4xx: discard without retry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-4xx-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PostgRESTError.isPermanent is true for 400, 403, 422', () => {
    for (const status of [400, 403, 422]) {
      const err = new PostgRESTError(status, true, `HTTP ${status}`);
      expect(err.isPermanent).toBe(true);
      expect(err.status).toBe(status);
    }
  });

  it('PostgRESTError.isPermanent is false for 500, 503, 409', () => {
    for (const status of [500, 503, 409]) {
      const err = new PostgRESTError(status, false, `HTTP ${status}`);
      expect(err.isPermanent).toBe(false);
    }
  });

  it('mirrorTaskToRgos: HTTP 400 → discards, no retry queue entry', async () => {
    mockFetchHttpError(400, '{"message":"malformed request"}');
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('mirrorTaskToRgos: HTTP 403 → discards, no retry queue entry', async () => {
    mockFetchHttpError(403, '{"message":"Forbidden"}');
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('mirrorTaskToRgos: HTTP 422 → discards, no retry queue entry', async () => {
    mockFetchHttpError(422, '{"code":"23514","message":"constraint violation"}');
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('mirrorMessageToRgos: HTTP 400 → discards, no retry queue entry', async () => {
    mockFetchHttpError(400, '{"message":"bad payload"}');
    const msg = makeMessage();
    await mirrorMessageToRgos(msg);
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('mirrorMessageToRgos: HTTP 422 → discards, no retry queue entry', async () => {
    mockFetchHttpError(422, '{"code":"23514","message":"enum violation"}');
    const msg = makeMessage();
    await mirrorMessageToRgos(msg);
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(false);
  });

  it('mirrorTaskToRgos: HTTP 500 still enqueues for retry (transient)', async () => {
    mockFetchHttpError(500, 'Internal Server Error');
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(true);
    expect(readRetryQueue(qPath)).toHaveLength(1);
  });
});

// ── P2: drain with 4xx entries (scenario 18) ────────────────────────────────

describe('rgos-mirror — drain: 4xx entries are discarded not re-queued', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-drain4xx-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drain: permanent 422 entry is discarded, queue is cleared', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_bad_enum') }, ts: '2026-04-27T00:00:00Z' });

    mockFetchHttpError(422, '{"code":"23514","message":"invalid enum"}');
    await drainRetryQueue();

    // Entry was discarded — queue should be empty
    expect(readRetryQueue(qPath)).toHaveLength(0);
  });

  it('drain: mixed queue — 422 discarded, 500 re-queued, success cleared', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_ok') }, ts: '2026-04-27T00:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_422') }, ts: '2026-04-27T00:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_500') }, ts: '2026-04-27T00:00:00Z' });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '' })                          // task_ok → success
      .mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"code":"23514"}' }) // task_422 → permanent
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'DB error' }),  // task_500 → transient
    );

    await drainRetryQueue();

    // Only task_500 should remain
    const remaining = readRetryQueue(qPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].row.id).toBe(uuidv5('task_500'));
  });
});

// ── P2: drain summary log (scenario 19) ─────────────────────────────────────

describe('rgos-mirror — drain summary log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-summary-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs drain summary with correct counts on full success', async () => {
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_a') }, ts: '2026-04-27T00:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_b') }, ts: '2026-04-27T00:00:00Z' });
    mockFetchOk();

    const logSpy = vi.spyOn(console, 'log');
    await drainRetryQueue();

    const summaryCall = logSpy.mock.calls.find(c => String(c[0]).includes('drain complete'));
    expect(summaryCall).toBeDefined();
    const msg = String(summaryCall![0]);
    expect(msg).toContain('queued=2');
    expect(msg).toContain('pushed=2');
    expect(msg).toContain('requeued=0');
    expect(msg).toContain('discarded=0');
    logSpy.mockRestore();
  });

  it('logs drain summary with requeued count when transient failures occur', async () => {
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_ok') }, ts: '2026-04-27T00:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_fail') }, ts: '2026-04-27T00:00:00Z' });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockRejectedValueOnce(new Error('network timeout')),
    );

    const logSpy = vi.spyOn(console, 'log');
    await drainRetryQueue();

    const summaryCall = logSpy.mock.calls.find(c => String(c[0]).includes('drain complete'));
    expect(summaryCall).toBeDefined();
    const msg = String(summaryCall![0]);
    expect(msg).toContain('queued=2');
    expect(msg).toContain('pushed=1');
    expect(msg).toContain('requeued=1');
    expect(msg).toContain('discarded=0');
    logSpy.mockRestore();
  });

  it('logs drain summary with discarded count when permanent errors occur', async () => {
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_ok') }, ts: '2026-04-27T00:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: uuidv5('task_422') }, ts: '2026-04-27T00:00:00Z' });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"code":"23514"}' }),
    );

    const logSpy = vi.spyOn(console, 'log');
    await drainRetryQueue();

    const summaryCall = logSpy.mock.calls.find(c => String(c[0]).includes('drain complete'));
    expect(summaryCall).toBeDefined();
    const msg = String(summaryCall![0]);
    expect(msg).toContain('queued=2');
    expect(msg).toContain('pushed=1');
    expect(msg).toContain('requeued=0');
    expect(msg).toContain('discarded=1');
    logSpy.mockRestore();
  });
});

// ── mirrorEventToRgos — full coverage ────────────────────────────────────────

const ORG_ID_FIXED = '00000000-0000-0000-0000-000000000001';

function makeEvent(overrides: Partial<{
  id: string;
  agent: string;
  org: string;
  timestamp: string;
  category: string;
  event: string;
  severity: string;
  metadata: Record<string, unknown>;
}> = {}) {
  return {
    id: 'evt_test_001',
    agent: 'dev',
    org: 'revops-global',
    timestamp: '2026-04-30T12:00:00.000Z',
    category: 'action',
    event: 'session_start',
    severity: 'info',
    metadata: {},
    ...overrides,
  };
}

describe('rgos-mirror — mirrorEventToRgos', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-event-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('upserts orch_events with correct row shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const evt = makeEvent({ id: 'evt_abc', agent: 'dev', category: 'action', event: 'session_start' });
    await mirrorEventToRgos(evt);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/v1/orch_events');

    const body = JSON.parse(options.body as string);
    expect(body.id).toMatch(UUID_V5_RE);
    expect(body.id).toBe(uuidv5('evt_abc'));
    expect(body.org_id).toBe(ORG_ID_FIXED);
    expect(body.agent_id).toBe('dev');
    expect(body.message).toBe('session_start');
  });

  // ── CRITICAL: PR #41 regression guard ─────────────────────────────────────

  it('sets event_type = event.category (not hardcoded agent_message)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent({ category: 'heartbeat', event: 'heartbeat' }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.event_type).toBe('heartbeat');
    expect(body.event_type).not.toBe('agent_message');
  });

  it.each([
    'action', 'error', 'metric', 'milestone', 'heartbeat',
    'message', 'task', 'approval', 'agent_activity',
  ] as const)('passes EventCategory "%s" through as event_type unchanged', async (category) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent({ category }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.event_type).toBe(category);
  });

  // ── task_id extraction ─────────────────────────────────────────────────────

  it('extracts task_id when metadata.task_id is a valid UUID', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    await mirrorEventToRgos(makeEvent({ metadata: { task_id: validUuid } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.task_id).toBe(validUuid);
  });

  it('converts non-UUID bus task_id to uuidv5 for ID unification', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const busTaskId = 'task_1234567890_001';
    await mirrorEventToRgos(makeEvent({ metadata: { task_id: busTaskId } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Non-UUID bus IDs are converted to the same uuidv5 the task row uses,
    // so orch_events.task_id resolves to the canonical RGOS UUID.
    expect(body.task_id).toBe(uuidv5(busTaskId));
  });

  it('sets task_id = null when metadata.task_id is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent({ metadata: {} }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.task_id).toBeNull();
  });

  // ── metadata enrichment ────────────────────────────────────────────────────

  it('enriches metadata with category and bus_event fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent({
      category: 'action',
      event: 'task_completed',
      metadata: { task_id: 'abc', extra: 'data' },
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.metadata.category).toBe('action');
    expect(body.metadata.bus_event).toBe('task_completed');
    expect(body.metadata.task_id).toBe('abc');
    expect(body.metadata.extra).toBe('data');
  });

  // ── Kill switch ────────────────────────────────────────────────────────────

  it('no-ops when BUS_RGOS_MIRROR_DISABLED=1', async () => {
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when SUPABASE_RGOS_URL is missing', async () => {
    delete process.env.SUPABASE_RGOS_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await mirrorEventToRgos(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Network failure → retry queue ──────────────────────────────────────────

  it('enqueues to retry with table=orch_events on network failure', async () => {
    mockFetchFail('connection refused');

    await mirrorEventToRgos(makeEvent({ id: 'evt_retry_me', category: 'heartbeat' }));

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const queue = readRetryQueue(qPath);
    expect(queue).toHaveLength(1);
    expect(queue[0].table).toBe('orch_events');
    expect(queue[0].row.id).toBe(uuidv5('evt_retry_me'));
    expect(queue[0].row.event_type).toBe('heartbeat');
  });

  it('retry entry respects EVENT_RETRY_MAX retries_remaining', async () => {
    mockFetchFail('timeout');

    await mirrorEventToRgos(makeEvent({ id: 'evt_cap_test' }));

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const queue = readRetryQueue(qPath);
    expect(queue).toHaveLength(1);
    expect(queue[0].retries_remaining).toBe(3); // EVENT_RETRY_MAX
  });

  // ── Permanent 4xx → discard ────────────────────────────────────────────────

  it('discards without retry queue entry on permanent 4xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"code":"23514","message":"new row violates check constraint"}',
    }));

    const errSpy = vi.spyOn(console, 'error');
    await mirrorEventToRgos(makeEvent({ id: 'evt_permanent' }));

    const queue = readRetryQueue(join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl'));
    expect(queue).toHaveLength(0);
    const errCall = errSpy.mock.calls.find(c => String(c[0]).includes('permanent error'));
    expect(errCall).toBeDefined();
    errSpy.mockRestore();
  });

  it('discards without retry queue entry on 422 (permanent)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"code":"23514","message":"invalid input"}',
    }));

    await mirrorEventToRgos(makeEvent({ id: 'evt_422' }));

    const queue = readRetryQueue(join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl'));
    expect(queue).toHaveLength(0);
  });
});

// ── drainRetryQueue — orch_events table path (smoke) ────────────────────────

describe('rgos-mirror — drainRetryQueue handles orch_events entries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-drain-event-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('successfully drains an orch_events retry entry', async () => {
    enqueueRetry({
      table: 'orch_events',
      row: { id: uuidv5('evt_drain_01'), event_type: 'heartbeat', agent_id: 'dev' },
      ts: '2026-04-30T00:00:00Z',
    });

    mockFetchOk();
    await drainRetryQueue();

    const remaining = readRetryQueue(join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl'));
    expect(remaining).toHaveLength(0);
  });

  it('upserts to orch_events endpoint (not orch_tasks) when draining event entry', async () => {
    enqueueRetry({
      table: 'orch_events',
      row: { id: uuidv5('evt_drain_02'), event_type: 'action', agent_id: 'dev' },
      ts: '2026-04-30T00:00:00Z',
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await drainRetryQueue();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/v1/orch_events');
    expect(url).not.toContain('/rest/v1/orch_tasks');
  });
});
