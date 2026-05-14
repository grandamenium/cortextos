import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  spawnFailureHistoryPath,
  readSpawnFailureHistory,
  recordSpawnFailure,
  countRecentDistinctAgents,
  shouldEscalate,
  buildEscalationMessage,
  recordAndMaybeEscalate,
  SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD,
  SPAWN_FAIL_COOLDOWN_MS,
  SPAWN_FAIL_HISTORY_MAX,
  SpawnFailureHistory,
} from '../../../src/daemon/spawn-failure-tracker';

// Regression guard for issue #07 (2026-05-14): pty.spawn() failing across
// multiple agents in a short window is the signature of a stale node-pty
// binding (typically after a pnpm install). Per-agent retry can't fix it —
// only a fresh daemon process can. The tracker turns the cross-agent
// pattern into a process.exit(1) so PM2 respawns the daemon.

function mkCtxRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-spawn-fail-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

describe('spawn-failure history persistence', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns empty history when no file exists', () => {
    const h = readSpawnFailureHistory(ctxRoot);
    expect(h.events).toEqual([]);
    expect(h.lastAlertAt).toBeUndefined();
    expect(h.lastSelfRestartAt).toBeUndefined();
  });

  it('returns empty history on corrupt JSON', () => {
    writeFileSync(spawnFailureHistoryPath(ctxRoot), 'not valid json{{{', 'utf-8');
    const h = readSpawnFailureHistory(ctxRoot);
    expect(h.events).toEqual([]);
  });

  it('recordSpawnFailure appends and caps at SPAWN_FAIL_HISTORY_MAX', () => {
    for (let i = 0; i < SPAWN_FAIL_HISTORY_MAX + 5; i++) {
      recordSpawnFailure(ctxRoot, `agent-${i}`, `err ${i}`);
    }
    const h = readSpawnFailureHistory(ctxRoot);
    expect(h.events.length).toBe(SPAWN_FAIL_HISTORY_MAX);
    // Oldest trimmed — last recorded is what survives.
    expect(h.events[h.events.length - 1].agent).toBe(`agent-${SPAWN_FAIL_HISTORY_MAX + 4}`);
  });

  it('recordSpawnFailure truncates very long error strings', () => {
    const huge = 'x'.repeat(2000);
    recordSpawnFailure(ctxRoot, 'alice', huge);
    const h = readSpawnFailureHistory(ctxRoot);
    expect(h.events[0].err.length).toBeLessThanOrEqual(500);
  });
});

describe('countRecentDistinctAgents', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('counts unique agents within the window', () => {
    const history: SpawnFailureHistory = {
      events: [
        { ts: minAgo(1), agent: 'alice', err: 'posix_spawnp failed' },
        { ts: minAgo(2), agent: 'bob', err: 'posix_spawnp failed' },
        { ts: minAgo(3), agent: 'alice', err: 'posix_spawnp failed' }, // dup agent
      ],
    };
    expect(countRecentDistinctAgents(history)).toBe(2);
  });

  it('ignores events outside the 5min window', () => {
    const history: SpawnFailureHistory = {
      events: [
        { ts: minAgo(1), agent: 'alice', err: 'err' },
        { ts: minAgo(10), agent: 'bob', err: 'err' }, // outside window
      ],
    };
    expect(countRecentDistinctAgents(history)).toBe(1);
  });

  it('returns 0 on empty history', () => {
    expect(countRecentDistinctAgents({ events: [] })).toBe(0);
  });
});

describe('shouldEscalate', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('returns false below the distinct-agents threshold', () => {
    // 5 events from ONE agent in window — phase 1's per-agent retry/halt
    // is the correct path here, NOT a daemon restart.
    const history: SpawnFailureHistory = {
      events: [
        { ts: minAgo(0.1), agent: 'alice', err: 'err' },
        { ts: minAgo(0.2), agent: 'alice', err: 'err' },
        { ts: minAgo(0.3), agent: 'alice', err: 'err' },
        { ts: minAgo(0.4), agent: 'alice', err: 'err' },
        { ts: minAgo(0.5), agent: 'alice', err: 'err' },
      ],
    };
    expect(shouldEscalate(history)).toBe(false);
  });

  it('returns true at distinct-agents threshold and no cooldown active', () => {
    const events: SpawnFailureHistory['events'] = [];
    for (let i = 0; i < SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD; i++) {
      events.push({ ts: minAgo(0.1), agent: `agent-${i}`, err: 'err' });
    }
    expect(shouldEscalate({ events })).toBe(true);
  });

  it('respects cooldown: returns false within SPAWN_FAIL_COOLDOWN_MS of last self-restart', () => {
    const events: SpawnFailureHistory['events'] = [];
    for (let i = 0; i < SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD + 2; i++) {
      events.push({ ts: minAgo(0.1), agent: `agent-${i}`, err: 'err' });
    }
    // Last restart was 5 min ago — cooldown is 30 min, so we're still inside.
    const history: SpawnFailureHistory = {
      events,
      lastSelfRestartAt: new Date(now - 5 * 60_000).toISOString(),
    };
    expect(shouldEscalate(history)).toBe(false);
  });

  it('cooldown expires after SPAWN_FAIL_COOLDOWN_MS', () => {
    const events: SpawnFailureHistory['events'] = [];
    for (let i = 0; i < SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD + 2; i++) {
      events.push({ ts: minAgo(0.1), agent: `agent-${i}`, err: 'err' });
    }
    const history: SpawnFailureHistory = {
      events,
      lastSelfRestartAt: new Date(now - SPAWN_FAIL_COOLDOWN_MS - 60_000).toISOString(),
    };
    expect(shouldEscalate(history)).toBe(true);
  });
});

describe('buildEscalationMessage', () => {
  const now = Date.now();
  const minAgo = (n: number): string => new Date(now - n * 60_000).toISOString();

  it('includes distinct agent list and latest error', () => {
    const history: SpawnFailureHistory = {
      events: [
        { ts: minAgo(2), agent: 'alice', err: 'posix_spawnp failed' },
        { ts: minAgo(1), agent: 'bob', err: 'posix_spawnp failed' },
        { ts: minAgo(0.1), agent: 'carol', err: 'EAGAIN: resource temporarily unavailable' },
      ],
    };
    const msg = buildEscalationMessage(history);
    expect(msg).toMatch(/CRITICAL/);
    expect(msg).toMatch(/alice/);
    expect(msg).toMatch(/bob/);
    expect(msg).toMatch(/carol/);
    // Latest error wins for the "Latest err:" line — alphabetic order is incidental.
    expect(msg).toMatch(/EAGAIN/);
  });

  it('excludes events outside the window from the agent list', () => {
    const history: SpawnFailureHistory = {
      events: [
        { ts: minAgo(10), agent: 'old-alice', err: 'old' },
        { ts: minAgo(0.1), agent: 'fresh-bob', err: 'new' },
      ],
    };
    const msg = buildEscalationMessage(history);
    expect(msg).not.toMatch(/old-alice/);
    expect(msg).toMatch(/fresh-bob/);
  });
});

describe('recordAndMaybeEscalate', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  beforeEach(() => {
    ctxRoot = mkCtxRoot();
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-fw-'));
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('first agent failure: records, does NOT escalate (threshold not met)', () => {
    const r = recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'posix_spawnp failed');
    expect(r.escalated).toBe(false);
    expect(r.history.events.length).toBe(1);
    expect(r.history.lastSelfRestartAt).toBeUndefined();
  });

  it('second DISTINCT agent failure: escalates (threshold met)', () => {
    recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'posix_spawnp failed');
    // No CTX_OPERATOR_BOT_TOKEN set + no orgs/ in frameworkRoot → curl is
    // never invoked. recordAndMaybeEscalate still returns escalated=true
    // because the alert send is best-effort, not gating.
    const r = recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'bob', 'posix_spawnp failed');
    expect(r.escalated).toBe(true);
    expect(r.history.lastSelfRestartAt).toBeDefined();
  });

  it('same agent re-failing does NOT escalate', () => {
    recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'err 1');
    const r = recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'err 2');
    expect(r.escalated).toBe(false);
    // Both events recorded.
    expect(r.history.events.length).toBe(2);
  });

  it('cooldown prevents back-to-back escalations', () => {
    recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'err');
    const r1 = recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'bob', 'err');
    expect(r1.escalated).toBe(true);
    // A third distinct agent fails immediately after — still within cooldown.
    const r2 = recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'carol', 'err');
    expect(r2.escalated).toBe(false);
  });

  it('persists history across calls (survives daemon restart)', () => {
    recordAndMaybeEscalate(ctxRoot, frameworkRoot, 'alice', 'err');
    // Simulate daemon restart by reading fresh.
    const reloaded = readSpawnFailureHistory(ctxRoot);
    expect(reloaded.events.length).toBe(1);
    expect(reloaded.events[0].agent).toBe('alice');
  });
});
