/**
 * Fleet-resilience plan #1 — cron-dispatch storm detector.
 *
 * Modeled on tests/unit/daemon/spawn-failure-tracker.test.ts. The
 * load-bearing new dimension is *distinctness on cronName*: the same cron
 * repeating must NOT trip the alert, but three different cron names
 * failing to reach the same agent inside the window must.
 *
 * The operator-alert Telegram delivery is short-circuited by stubbing
 * spawnSync via vi.mock so we never let curl run for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub child_process.spawnSync so the operator-alert send returns success
// without hitting the network.
const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

import {
  cronDispatchHistoryPath,
  readCronDispatchHistory,
  countRecentDistinctCrons,
  shouldEscalate,
  buildEscalationMessage,
  recordCronDispatchAndMaybeEscalate,
  CRON_DISPATCH_HISTORY_MAX,
  CRON_DISPATCH_DISTINCT_THRESHOLD,
  CRON_DISPATCH_COOLDOWN_MS,
  CRON_DISPATCH_WINDOW_MS,
  type CronDispatchHistory,
} from '../../../src/daemon/cron-dispatch-tracker';

function mkCtxRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-cron-dispatch-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

const ORIG_ENV_CHAT = process.env.CTX_OPERATOR_CHAT_ID;
const ORIG_ENV_TOKEN = process.env.CTX_OPERATOR_BOT_TOKEN;

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  process.env.CTX_OPERATOR_CHAT_ID = '12345';
  process.env.CTX_OPERATOR_BOT_TOKEN = '99999:fakefakefakefakefakeABCDEFGHIJ';
});

afterEach(() => {
  if (ORIG_ENV_CHAT === undefined) delete process.env.CTX_OPERATOR_CHAT_ID;
  else process.env.CTX_OPERATOR_CHAT_ID = ORIG_ENV_CHAT;
  if (ORIG_ENV_TOKEN === undefined) delete process.env.CTX_OPERATOR_BOT_TOKEN;
  else process.env.CTX_OPERATOR_BOT_TOKEN = ORIG_ENV_TOKEN;
});

describe('cron-dispatch history persistence', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns empty history when no file exists', () => {
    const h = readCronDispatchHistory(ctxRoot);
    expect(h.events).toEqual([]);
    expect(h.lastAlertAt).toBeUndefined();
  });

  it('returns empty history on corrupt JSON', () => {
    writeFileSync(cronDispatchHistoryPath(ctxRoot), 'not valid json{{{', 'utf-8');
    expect(readCronDispatchHistory(ctxRoot).events).toEqual([]);
  });

  it('record appends and caps at CRON_DISPATCH_HISTORY_MAX', () => {
    for (let i = 0; i < CRON_DISPATCH_HISTORY_MAX + 5; i++) {
      recordCronDispatchAndMaybeEscalate(ctxRoot, '/tmp/no-fw', 'alice', `cron-${i}`);
    }
    const h = readCronDispatchHistory(ctxRoot);
    expect(h.events.length).toBe(CRON_DISPATCH_HISTORY_MAX);
    expect(h.events[h.events.length - 1].cronName).toBe(`cron-${CRON_DISPATCH_HISTORY_MAX + 4}`);
  });
});

describe('countRecentDistinctCrons', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('counts unique cron names for the agent in the window', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'heartbeat' },
        { ts: minAgo(2), agent: 'boss', cronName: 'morning-review' },
        { ts: minAgo(3), agent: 'boss', cronName: 'heartbeat' },  // dup cron — counts once
      ],
    };
    expect(countRecentDistinctCrons(history, 'boss').sort()).toEqual(['heartbeat', 'morning-review']);
  });

  it('filters out events for other agents', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'heartbeat' },
        { ts: minAgo(2), agent: 'analyst', cronName: 'heartbeat' },
      ],
    };
    expect(countRecentDistinctCrons(history, 'boss')).toEqual(['heartbeat']);
    expect(countRecentDistinctCrons(history, 'analyst')).toEqual(['heartbeat']);
  });

  it('drops events older than the window', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'heartbeat' },
        { ts: minAgo((CRON_DISPATCH_WINDOW_MS / 60_000) + 1), agent: 'boss', cronName: 'ancient-cron' },
      ],
    };
    expect(countRecentDistinctCrons(history, 'boss')).toEqual(['heartbeat']);
  });
});

describe('shouldEscalate', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('returns false below the distinct-cron threshold', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'a' },
        { ts: minAgo(2), agent: 'boss', cronName: 'b' },
      ],
    };
    expect(shouldEscalate(history, 'boss')).toBe(false);
  });

  it('returns true when distinct crons reach the threshold', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'a' },
        { ts: minAgo(2), agent: 'boss', cronName: 'b' },
        { ts: minAgo(3), agent: 'boss', cronName: 'c' },
      ],
    };
    expect(CRON_DISPATCH_DISTINCT_THRESHOLD).toBe(3);
    expect(shouldEscalate(history, 'boss')).toBe(true);
  });

  it('respects the cooldown — no re-escalation inside the window', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'a' },
        { ts: minAgo(2), agent: 'boss', cronName: 'b' },
        { ts: minAgo(3), agent: 'boss', cronName: 'c' },
      ],
      lastAlertAt: new Date(now - 10 * 60_000).toISOString(), // 10 min ago, cooldown is 60 min
    };
    expect(shouldEscalate(history, 'boss')).toBe(false);
  });

  it('escalates again after the cooldown elapses', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'a' },
        { ts: minAgo(2), agent: 'boss', cronName: 'b' },
        { ts: minAgo(3), agent: 'boss', cronName: 'c' },
      ],
      lastAlertAt: new Date(now - (CRON_DISPATCH_COOLDOWN_MS + 1000)).toISOString(),
    };
    expect(shouldEscalate(history, 'boss')).toBe(true);
  });
});

describe('buildEscalationMessage', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('mentions agent, count, the distinct cron list, and the remediation hint', () => {
    const history: CronDispatchHistory = {
      events: [
        { ts: minAgo(1), agent: 'boss', cronName: 'heartbeat' },
        { ts: minAgo(2), agent: 'boss', cronName: 'morning-review' },
        { ts: minAgo(3), agent: 'boss', cronName: 'check-approvals' },
      ],
    };
    const msg = buildEscalationMessage(history, 'boss');
    expect(msg).toContain('boss');
    expect(msg).toContain('heartbeat');
    expect(msg).toContain('morning-review');
    expect(msg).toContain('check-approvals');
    expect(msg).toContain('cortextos restart boss');
  });
});

describe('recordCronDispatchAndMaybeEscalate', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  beforeEach(() => {
    ctxRoot = mkCtxRoot();
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-cron-fw-'));
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('first two distinct crons do not escalate', () => {
    expect(recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'heartbeat').escalated).toBe(false);
    expect(recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'morning-review').escalated).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('third DISTINCT cron in window escalates exactly once', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'heartbeat');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'morning-review');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'check-approvals');
    expect(r.escalated).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('same cron repeating does NOT count toward distinctness', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'heartbeat');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'heartbeat');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'heartbeat');
    expect(r.escalated).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('two crons + one repeat does NOT escalate', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a'); // repeat
    expect(r.escalated).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('per-agent isolation: agent X failures do not trip agent Y', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'analyst', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'analyst', 'b');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c');
    expect(r.escalated).toBe(false);
    // boss only has 2 distinct (a, c); analyst has 2 distinct (a, b). Neither escalates.
  });

  it('cooldown gates a second escalation in the same window', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b');
    const first = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c');
    expect(first.escalated).toBe(true);
    spawnSyncMock.mockClear();
    // Fourth distinct cron right after the alert — still inside cooldown.
    const second = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'd');
    expect(second.escalated).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('persists lastAlertAt atomically before the alert fires', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c');
    expect(existsSync(cronDispatchHistoryPath(ctxRoot))).toBe(true);
    const onDisk = JSON.parse(readFileSync(cronDispatchHistoryPath(ctxRoot), 'utf-8'));
    expect(onDisk.lastAlertAt).toBeTruthy();
    expect(onDisk.events.length).toBe(3);
  });

  it('survives a corrupt history file and starts fresh', () => {
    writeFileSync(cronDispatchHistoryPath(ctxRoot), 'not valid json', 'utf-8');
    const r1 = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    expect(r1.escalated).toBe(false);
    expect(r1.history.events.length).toBe(1);
  });

  it('threshold override (from daemon.json) tightens the gate', () => {
    // Default threshold is 3; override to 2 → escalates on the second distinct cron.
    expect(recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a', 2).escalated).toBe(false);
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b', 2);
    expect(r.escalated).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('threshold override (looser) suppresses an alert that would have fired at default', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a', 5);
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b', 5);
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c', 5);
    expect(r.escalated).toBe(false); // 3 distinct, but threshold is 5
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // Fleet-resilience cleanup A: when instanceId+org are passed, escalation
  // also writes a JSONL event under the `_daemon` synthetic agent identity
  // (alongside the existing stderr line + operator alert).
  it('emits a cron_dispatch_storm_detected JSONL row under _daemon when escalating', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a', undefined, 'test-instance', 'acme');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b', undefined, 'test-instance', 'acme');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c', undefined, 'test-instance', 'acme');
    expect(r.escalated).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const file = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', '_daemon', `${today}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const rows = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('cron_dispatch_storm_detected');
    expect(rows[0].metadata).toMatchObject({ agent: 'boss', window_minutes: 30 });
    expect(rows[0].metadata.crons).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('skips JSONL emission when instanceId/org omitted (stderr-only fallback)', () => {
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'a');
    recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'b');
    const r = recordCronDispatchAndMaybeEscalate(ctxRoot, frameworkRoot, 'boss', 'c');
    expect(r.escalated).toBe(true);

    expect(existsSync(join(ctxRoot, 'orgs'))).toBe(false);
  });
});
