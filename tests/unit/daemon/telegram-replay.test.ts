import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types';
import {
  replayMissedTelegram,
  warnStaleTasks,
  readCursor,
  selectMissed,
  chatKey,
  type InboundEntry,
} from '../../../src/daemon/telegram-replay';

// Fixed clock for deterministic windows.
const NOW = Date.parse('2026-08-13T12:00:00Z');
const H = 60 * 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function entry(message_id: number, chat_id: number | string, agoMs: number, extra: Partial<InboundEntry> = {}): InboundEntry {
  return { message_id, chat_id, archived_at: isoAgo(agoMs), from_name: 'Tester', text: `msg ${message_id}`, ...extra };
}

function writeInbound(logDir: string, entries: InboundEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(logDir, 'inbound-messages.jsonl'), lines, 'utf-8');
}

function writeCursorFile(stateDir: string, cursor: Record<string, number>): void {
  writeFileSync(join(stateDir, 'telegram-cursor.json'), JSON.stringify(cursor), 'utf-8');
}

function writeHeartbeat(stateDir: string, lastAliveAgoMs: number): void {
  writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({ last_heartbeat: isoAgo(lastAliveAgoMs) }), 'utf-8');
}

function writeTask(taskDir: string, id: string, status: string, updatedAgoMs: number): void {
  const t = {
    id,
    title: `task ${id}`,
    description: '',
    status,
    priority: 'normal',
    agent: 'test-agent',
    created_at: isoAgo(updatedAgoMs + H),
    updated_at: isoAgo(updatedAgoMs),
  };
  writeFileSync(join(taskDir, `${id}.json`), JSON.stringify(t), 'utf-8');
}

/** archived_at extracted from a formatted [REPLAYED ...] block, for order assertions. */
function replayedAts(calls: string[]): string[] {
  return calls
    .map((c) => c.match(/REPLAYED ([^)]+)\)/)?.[1])
    .filter((x): x is string => !!x);
}

describe('telegram-replay', () => {
  let testDir: string;
  let paths: BusPaths;
  let inject: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-replay-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox'),
      inflight: join(testDir, 'inflight'),
      processed: join(testDir, 'processed'),
      logDir: join(testDir, 'logs', 'test-agent'),
      stateDir: join(testDir, 'state', 'test-agent'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    } as BusPaths;
    for (const d of Object.values(paths)) {
      if (typeof d === 'string' && d !== testDir) mkdirSync(d, { recursive: true });
    }
    inject = vi.fn().mockReturnValue(true);
    emit = vi.fn();
  });

  afterEach(() => {
    try { chmodSync(paths.stateDir, 0o700); } catch { /* ignore */ }
    rmSync(testDir, { recursive: true, force: true });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      stateDir: paths.stateDir,
      logDir: paths.logDir,
      paths,
      agentName: 'test-agent',
      org: 'testorg',
      inject,
      now: NOW,
      emit,
      ...overrides,
    };
  }

  // Test 1 — no cursor, entries present → start-from-now
  it('no cursor file + entries present → initializes cursor to max/chat, no replay', () => {
    writeInbound(paths.logDir, [
      entry(101, 'chatA', 1 * H), entry(102, 'chatA', 0.5 * H),
      entry(201, 'chatB', 2 * H), entry(202, 'chatB', 1 * H), entry(203, 'chatB', 0.2 * H),
    ]);
    const res = replayMissedTelegram(deps());
    expect(res.firstRun).toBe(true);
    expect(inject).not.toHaveBeenCalled();
    const cursor = readCursor(paths.stateDir);
    expect(cursor).toEqual({ chatA: 102, chatB: 203 });
  });

  // Test 2 — cursor stale, entries newer within 24h → replay in ASC order
  it('stale cursor + newer entries within 24h → replays all in archived_at ASC order, advances cursor', () => {
    writeCursorFile(paths.stateDir, { chatA: 100, chatB: 200 });
    writeInbound(paths.logDir, [
      entry(101, 'chatA', 5 * H), entry(102, 'chatA', 4 * H), entry(103, 'chatA', 3 * H),
      entry(104, 'chatA', 2 * H), entry(105, 'chatA', 1 * H),
      entry(201, 'chatB', 4.5 * H), entry(202, 'chatB', 2.5 * H), entry(203, 'chatB', 0.5 * H),
    ]);
    const res = replayMissedTelegram(deps());
    expect(res.replayed).toBe(8);
    expect(inject).toHaveBeenCalledTimes(8);
    const ats = replayedAts(inject.mock.calls.map((c) => c[0] as string));
    const sorted = [...ats].sort();
    expect(ats).toEqual(sorted); // ASC chronological
    expect(readCursor(paths.stateDir)).toEqual({ chatA: 105, chatB: 203 });
  });

  // Test 3 — entries older than 24h → skipped
  it('entry older than 24h → skipped, cursor unchanged', () => {
    writeCursorFile(paths.stateDir, { chatA: 100 });
    writeInbound(paths.logDir, [entry(101, 'chatA', 25 * H)]);
    const res = replayMissedTelegram(deps());
    expect(res.replayed).toBe(0);
    expect(inject).not.toHaveBeenCalled();
    expect(readCursor(paths.stateDir)).toEqual({ chatA: 100 });
  });

  // Test 4 — per-chat cap enforced (freshest 100)
  it('150 entries in one chat within 24h → replays freshest 100, cursor to newest', () => {
    writeCursorFile(paths.stateDir, { chatA: 0 });
    const entries: InboundEntry[] = [];
    for (let i = 1; i <= 150; i++) {
      // higher id = fresher (smaller agoMs); all within 24h
      entries.push(entry(i, 'chatA', (151 - i) * 0.1 * H));
    }
    writeInbound(paths.logDir, entries);
    const res = replayMissedTelegram(deps());
    expect(res.replayed).toBe(100);
    expect(inject).toHaveBeenCalledTimes(100);
    // freshest 100 = ids 51..150; cursor advances to 150
    expect(readCursor(paths.stateDir)).toEqual({ chatA: 150 });
  });

  // Test 5 — downtime warning when gap > 4h
  it('gap > 4h → first inject is [STARTUP] downtime warning, then entries', () => {
    writeCursorFile(paths.stateDir, { chatA: 100 });
    writeHeartbeat(paths.stateDir, 6 * H);
    writeInbound(paths.logDir, [entry(101, 'chatA', 2 * H), entry(102, 'chatA', 1 * H)]);
    const res = replayMissedTelegram(deps());
    expect(res.downtimeHours).toBeCloseTo(6, 1);
    expect((inject.mock.calls[0][0] as string).startsWith('[STARTUP]')).toBe(true);
    expect(inject).toHaveBeenCalledTimes(3); // 1 warning + 2 entries
    expect(emit).toHaveBeenCalledWith('action', 'downtime_detected', 'warning', expect.objectContaining({ missed_count: 2 }));
  });

  // Test 6 — no downtime warning when gap < 4h
  it('gap < 4h → no [STARTUP] warning, only entries', () => {
    writeCursorFile(paths.stateDir, { chatA: 100 });
    writeHeartbeat(paths.stateDir, 0.5 * H);
    writeInbound(paths.logDir, [entry(101, 'chatA', 0.4 * H), entry(102, 'chatA', 0.2 * H)]);
    replayMissedTelegram(deps());
    expect(inject).toHaveBeenCalledTimes(2);
    for (const c of inject.mock.calls) expect((c[0] as string).startsWith('[STARTUP]')).toBe(false);
  });

  // Test 7 — stale-task warning fires
  it('3 in-progress tasks updated 3h ago (threshold 2h) → one [STALE-TASKS] warning with 3 ids', () => {
    writeTask(paths.taskDir, 'task_a', 'in_progress', 3 * H);
    writeTask(paths.taskDir, 'task_b', 'in_progress', 3 * H);
    writeTask(paths.taskDir, 'task_c', 'in_progress', 3 * H);
    const res = warnStaleTasks({ paths, agentName: 'test-agent', org: 'testorg', inject, now: NOW, thresholdHours: 2, emit });
    expect(res.stale).toBe(3);
    expect(inject).toHaveBeenCalledTimes(1);
    const msg = inject.mock.calls[0][0] as string;
    expect(msg.startsWith('[STALE-TASKS]')).toBe(true);
    for (const id of ['task_a', 'task_b', 'task_c']) expect(msg).toContain(id);
    expect(emit).toHaveBeenCalledWith('task', 'stale_tasks_warned', 'warning', { count: 3 });
  });

  // Test 8 — stale-task warning suppressed when fresh
  it('in-progress tasks updated 30min ago (threshold 2h) → no warning', () => {
    writeTask(paths.taskDir, 'task_a', 'in_progress', 0.5 * H);
    writeTask(paths.taskDir, 'task_b', 'in_progress', 0.5 * H);
    const res = warnStaleTasks({ paths, agentName: 'test-agent', org: 'testorg', inject, now: NOW, thresholdHours: 2, emit });
    expect(res.stale).toBe(0);
    expect(inject).not.toHaveBeenCalled();
  });

  // Test 9 — atomic cursor write survives partial failure
  it('cursor write failure after first inject → first inject done, replay halts, next run re-processes', () => {
    writeCursorFile(paths.stateDir, { chatA: 100 });
    writeInbound(paths.logDir, [
      entry(101, 'chatA', 3 * H), entry(102, 'chatA', 2 * H), entry(103, 'chatA', 1 * H),
    ]);
    // Make the state dir unwritable so atomicWriteSync (tmp write) throws, but
    // the existing cursor file stays readable.
    chmodSync(paths.stateDir, 0o500);
    const res = replayMissedTelegram(deps());
    // First entry injected; cursor write throws → loop breaks.
    expect(inject).toHaveBeenCalledTimes(1);
    expect(res.replayed).toBe(0); // replayed counter only increments after a durable cursor write
    // Restore writability; cursor never advanced → next run re-processes all 3.
    chmodSync(paths.stateDir, 0o700);
    inject.mockClear();
    const res2 = replayMissedTelegram(deps());
    expect(inject).toHaveBeenCalledTimes(3);
    expect(res2.replayed).toBe(3);
    expect(readCursor(paths.stateDir)).toEqual({ chatA: 103 });
  });

  // Test 10 — chat_id string normalization (int in archive, string key in cursor)
  it('int chat_id in archive matches string cursor key → no double-inject', () => {
    const groupId = -1003928420107;
    writeCursorFile(paths.stateDir, { [String(groupId)]: 500 });
    writeInbound(paths.logDir, [
      entry(500, groupId, 2 * H), // already seen (== cursor) → skip
      entry(501, groupId, 1 * H), // new → replay
    ]);
    // Sanity: pure selection respects the string/int key equivalence.
    const missed = selectMissed(
      [entry(500, groupId, 2 * H), entry(501, groupId, 1 * H)],
      { [chatKey(groupId)]: 500 },
      NOW,
    );
    expect(missed.map((m) => m.message_id)).toEqual([501]);

    const res = replayMissedTelegram(deps());
    expect(res.replayed).toBe(1);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(readCursor(paths.stateDir)).toEqual({ [String(groupId)]: 501 });
  });
});
