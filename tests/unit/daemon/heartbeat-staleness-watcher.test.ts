/**
 * Fleet-resilience plan #2 — heartbeat-staleness watchdog.
 *
 * Drives the watcher with an injectable clock + manual tick() so we never
 * need real timers; the operator-alert Telegram call is short-circuited by
 * the same spawnSync mock pattern used in the cron-dispatch tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

import { HeartbeatStalenessWatcher } from '../../../src/daemon/heartbeat-staleness-watcher';

let ctxRoot: string;
let frameworkRoot: string;
let clock: { ms: number };
const AGENT = 'boss';

const ORIG_ENV_CHAT = process.env.CTX_OPERATOR_CHAT_ID;
const ORIG_ENV_TOKEN = process.env.CTX_OPERATOR_BOT_TOKEN;

function writeHeartbeat(ageMs: number, task = 'cycle complete'): void {
  const dir = join(ctxRoot, 'state', AGENT);
  mkdirSync(dir, { recursive: true });
  const ts = new Date(clock.ms - ageMs).toISOString();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent: AGENT,
    org: 'acme',
    status: 'healthy',
    current_task: task,
    mode: 'day',
    last_heartbeat: ts,
    loop_interval: '5m',
  }));
}

function makeWatcher(thresholdMs = 10 * 60_000, realertMs = 30 * 60_000): HeartbeatStalenessWatcher {
  return new HeartbeatStalenessWatcher({
    agentName: AGENT,
    ctxRoot,
    frameworkRoot,
    thresholdMs,
    realertMs,
    logger: () => {},
    now: () => clock.ms,
  });
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-hb-watcher-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-hb-watcher-fw-'));
  clock = { ms: Date.parse('2026-05-15T12:00:00Z') };
  // The watcher uses the injected `now`, but emitOperatorAlert calls the
  // real Date.now() to check its cooldown. We pin both by combining the
  // injected clock with fake timers so they advance in lockstep.
  vi.useFakeTimers();
  vi.setSystemTime(clock.ms);
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  process.env.CTX_OPERATOR_CHAT_ID = '12345';
  process.env.CTX_OPERATOR_BOT_TOKEN = '99999:fakefakefakefakefakeABCDEFGHIJ';
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  if (ORIG_ENV_CHAT === undefined) delete process.env.CTX_OPERATOR_CHAT_ID;
  else process.env.CTX_OPERATOR_CHAT_ID = ORIG_ENV_CHAT;
  if (ORIG_ENV_TOKEN === undefined) delete process.env.CTX_OPERATOR_BOT_TOKEN;
  else process.env.CTX_OPERATOR_BOT_TOKEN = ORIG_ENV_TOKEN;
});

/** Advance both the injected watcher clock and the fake-timer system clock. */
function advance(ms: number): void {
  clock.ms += ms;
  vi.setSystemTime(clock.ms);
}

describe('HeartbeatStalenessWatcher', () => {
  it('does not flag a fresh heartbeat', () => {
    const w = makeWatcher();
    writeHeartbeat(30_000); // 30s ago, threshold 10m
    w.tick();
    expect(w.isArmed).toBe(true);
    expect(w.isStale).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does NOT alert on cold boot — waits for first heartbeat read before arming', () => {
    const w = makeWatcher();
    // No heartbeat file yet — fresh agent.
    w.tick();
    expect(w.isArmed).toBe(false);
    expect(w.isStale).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    w.tick();
    expect(w.isArmed).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('stale heartbeat triggers a CRITICAL alert at first detection', () => {
    const w = makeWatcher();
    writeHeartbeat(11 * 60_000); // 11 min ago, threshold 10m
    w.tick();
    expect(w.isStale).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('re-alert cadence: no alert at 10m, alert at 11m, re-alert at 41m', () => {
    const w = makeWatcher(10 * 60_000, 30 * 60_000);
    // Tick 1: 10 min exactly — boundary is `>`, so NOT stale yet.
    writeHeartbeat(10 * 60_000);
    w.tick();
    expect(spawnSyncMock).not.toHaveBeenCalled();

    // Tick 2: 11 min — first alert.
    writeHeartbeat(11 * 60_000);
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // Tick 3: still stale, but only 5 min after the first alert — suppressed.
    advance(5 * 60_000);
    writeHeartbeat(16 * 60_000); // still stale (16 min)
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // Tick 4: 30 min after the first alert (realertMs elapsed) — re-fires.
    advance(25 * 60_000); // total 30 min since first alert
    writeHeartbeat(41 * 60_000); // 41 min stale
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('heartbeat update during stale period clears watcher and logs recovered', () => {
    const logs: string[] = [];
    const w = new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      thresholdMs: 10 * 60_000,
      realertMs: 30 * 60_000,
      logger: (m) => logs.push(m),
      now: () => clock.ms,
    });
    writeHeartbeat(11 * 60_000);
    w.tick();
    expect(w.isStale).toBe(true);

    advance(2 * 60_000);
    writeHeartbeat(0); // fresh heartbeat now
    w.tick();

    expect(w.isStale).toBe(false);
    expect(logs.some((l) => l.includes('heartbeat_recovered'))).toBe(true);
  });

  it('transient ENOENT does not flag (requires 2 consecutive misses)', () => {
    const w = makeWatcher();
    // First read OK — arms the watcher.
    writeHeartbeat(30_000);
    w.tick();
    expect(w.isArmed).toBe(true);

    // Remove the file — first miss.
    rmSync(join(ctxRoot, 'state', AGENT), { recursive: true, force: true });
    w.tick();
    expect(w.isStale).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();

    // Second miss — flags stale.
    w.tick();
    expect(w.isStale).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('threshold=0 disables the watcher (start() is a no-op)', () => {
    // pollMs is unused since start() exits early; we still need a valid value.
    const w = new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      pollMs: 1000,
      thresholdMs: 0,
      realertMs: 30 * 60_000,
      logger: () => {},
      now: () => clock.ms,
    });
    w.start();
    // Even with a stale heartbeat on disk, manual tick() still runs but
    // start() never installs the interval — confirm start is idempotent.
    writeHeartbeat(60 * 60_000);
    // Calling stop() on a never-started watcher must not throw.
    expect(() => w.stop()).not.toThrow();
  });

  it('file-missing path renders a clearer alert text', () => {
    const w = makeWatcher();
    writeHeartbeat(30_000); // arm
    w.tick();
    expect(w.isArmed).toBe(true);
    rmSync(join(ctxRoot, 'state', AGENT), { recursive: true, force: true });
    w.tick(); // first miss
    w.tick(); // second miss → alert
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    const call = spawnSyncMock.mock.calls[0];
    const args = call[1] as string[];
    const dataArg = args.find((a) => a.startsWith('text='));
    expect(dataArg).toBeDefined();
    expect(dataArg).toContain('heartbeat file missing');
  });

  it('cooldown elapsed BUT heartbeat already recovered means no re-alert', () => {
    const w = makeWatcher();
    writeHeartbeat(11 * 60_000);
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // 2 min later — fresh heartbeat. Recovered.
    advance(2 * 60_000);
    writeHeartbeat(0);
    w.tick();
    expect(w.isStale).toBe(false);

    // 40 min later — fresh again, no stale. No re-alert.
    advance(40 * 60_000);
    writeHeartbeat(0);
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('HeartbeatStalenessWatcher — fleet-resilience cleanup A (daemon JSONL events)', () => {
  function makeJsonlWatcher(): HeartbeatStalenessWatcher {
    // Construct WITH instanceId + org so the watcher fires JSONL emissions
    // alongside the stderr lines.
    return new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      thresholdMs: 10 * 60_000,
      realertMs: 30 * 60_000,
      logger: () => {},
      now: () => clock.ms,
      instanceId: 'test-instance',
      org: 'acme',
    });
  }

  function readDaemonEvents(): Array<{ event: string; metadata: Record<string, unknown> }> {
    const today = new Date(clock.ms).toISOString().slice(0, 10);
    const file = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', '_daemon', `${today}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('emits a heartbeat_stale_detected JSONL row under _daemon when stale', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000);
    w.tick();

    const rows = readDaemonEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('heartbeat_stale_detected');
    expect(rows[0].metadata).toMatchObject({ agent: AGENT });
    expect(typeof rows[0].metadata.age_seconds).toBe('number');
    expect(typeof rows[0].metadata.threshold_seconds).toBe('number');
  });

  it('emits a heartbeat_recovered JSONL row on the recovery transition', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000);
    w.tick();
    expect(readDaemonEvents()).toHaveLength(1);

    advance(2 * 60_000);
    writeHeartbeat(0);
    w.tick();
    expect(w.isStale).toBe(false);

    const rows = readDaemonEvents();
    expect(rows).toHaveLength(2);
    expect(rows[1].event).toBe('heartbeat_recovered');
    expect(rows[1].metadata).toMatchObject({ agent: AGENT });
    expect(typeof rows[1].metadata.was_stale_for_seconds).toBe('number');
  });

  it('idle-suppress: empty current_task past threshold → no alert, idle_suppressed event, lastAlertAt unchanged', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000, ''); // 11 min stale, but agent is idle
    w.tick();

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(w.isStale).toBe(false); // staleSince untouched on suppression

    const rows = readDaemonEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('heartbeat_idle_suppressed');
    expect(rows[0].metadata).toMatchObject({ agent: AGENT });
    expect(typeof rows[0].metadata.age_seconds).toBe('number');
    expect(typeof rows[0].metadata.threshold_seconds).toBe('number');
  });

  it('idle→active transition: suppressed while idle, then alert fires when task is assigned and still stale', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000, ''); // idle + stale
    w.tick();
    expect(spawnSyncMock).not.toHaveBeenCalled();

    // Task now assigned; heartbeat still stale (cron hasn't fired yet).
    writeHeartbeat(11 * 60_000, 'working on Y');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledOnce();

    const rows = readDaemonEvents();
    // First tick wrote idle_suppressed; second wrote stale_detected.
    expect(rows.map((r) => r.event)).toEqual([
      'heartbeat_idle_suppressed',
      'heartbeat_stale_detected',
    ]);
  });

  it('idle-suppress is local to the suppression path: a non-empty task agent still alerts at threshold (regression lock)', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000, 'compiling shaders');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(w.isStale).toBe(true);
  });

  it('idle-suppress round-trip: stale→recovered→idle→active→stale resets lastAlertAt correctly across the cycle', () => {
    const w = makeJsonlWatcher();

    // Phase 1: agent with task goes stale → alert fires.
    writeHeartbeat(11 * 60_000, 'phase-1-work');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // Phase 2: heartbeat refreshes → recovered. lastAlertAt resets to null.
    advance(2 * 60_000);
    writeHeartbeat(0, 'phase-1-work');
    w.tick();
    expect(w.isStale).toBe(false);

    // Phase 3: agent goes idle (no task) + heartbeat goes stale again.
    // Long advance to ensure realertMs has elapsed since the phase-1 alert.
    advance(45 * 60_000);
    writeHeartbeat(11 * 60_000, '');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1); // still just the phase-1 alert

    // Phase 4: a task arrives while heartbeat is still stale. lastAlertAt was
    // reset by recovered() in phase 2, so this fires immediately (not gated
    // by leftover state from phase 1).
    writeHeartbeat(11 * 60_000, 'phase-4-work');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);

    const events = readDaemonEvents().map((r) => r.event);
    expect(events).toEqual([
      'heartbeat_stale_detected',
      'heartbeat_recovered',
      'heartbeat_idle_suppressed',
      'heartbeat_stale_detected',
    ]);
  });

  it('whitespace-only current_task is treated as idle (no alert, idle_suppressed emitted)', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000, '   ');
    w.tick();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const rows = readDaemonEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('heartbeat_idle_suppressed');
  });

  it('idle-suppress does not block recovery: agent with task goes stale, then heartbeat refreshes → recovered fires', () => {
    const w = makeJsonlWatcher();
    writeHeartbeat(11 * 60_000, 'busy');
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledOnce();

    advance(2 * 60_000);
    writeHeartbeat(0, 'busy');
    w.tick();
    expect(w.isStale).toBe(false);

    const rows = readDaemonEvents();
    expect(rows.map((r) => r.event)).toEqual([
      'heartbeat_stale_detected',
      'heartbeat_recovered',
    ]);
  });

  it('without instanceId+org, falls back to stderr-only (no JSONL row written)', () => {
    const w = new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      thresholdMs: 10 * 60_000,
      realertMs: 30 * 60_000,
      logger: () => {},
      now: () => clock.ms,
      // instanceId + org intentionally omitted
    });
    writeHeartbeat(11 * 60_000);
    w.tick();

    expect(readDaemonEvents()).toHaveLength(0);
  });
});

describe('HeartbeatStalenessWatcher — Path B task-stuck signal', () => {
  function writeHeartbeatWithTaskStart(opts: {
    task: string;
    lastHeartbeatAgeMs: number;
    taskStartedAgeMs: number | null;
  }): void {
    const dir = join(ctxRoot, 'state', AGENT);
    mkdirSync(dir, { recursive: true });
    const lastHb = new Date(clock.ms - opts.lastHeartbeatAgeMs).toISOString();
    const taskStartedAt = opts.taskStartedAgeMs === null
      ? null
      : new Date(clock.ms - opts.taskStartedAgeMs).toISOString();
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
      agent: AGENT,
      org: 'acme',
      status: 'healthy',
      current_task: opts.task,
      mode: 'day',
      last_heartbeat: lastHb,
      loop_interval: '5m',
      task_started_at: taskStartedAt,
    }));
  }

  function makeTaskStuckWatcher(opts?: {
    taskStuckThresholdMs?: number;
    taskStuckRealertMs?: number;
    instanceId?: string;
    org?: string;
  }): HeartbeatStalenessWatcher {
    return new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      // High staleness threshold so the existing leg doesn't fire and confuse
      // the task-stuck assertions. Tests target the Path B leg in isolation.
      thresholdMs: 4 * 60 * 60_000,
      realertMs: 30 * 60_000,
      taskStuckThresholdMs: opts?.taskStuckThresholdMs ?? 30 * 60_000,
      taskStuckRealertMs: opts?.taskStuckRealertMs ?? 30 * 60_000,
      logger: () => {},
      now: () => clock.ms,
      instanceId: opts?.instanceId,
      org: opts?.org,
    });
  }

  function readDaemonEvents(): Array<{ event: string; metadata: Record<string, unknown> }> {
    const today = new Date(clock.ms).toISOString().slice(0, 10);
    const file = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', '_daemon', `${today}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('does not fire when task age is below threshold', () => {
    const w = makeTaskStuckWatcher();
    writeHeartbeatWithTaskStart({ task: 'task-A', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 5 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('fires when task age exceeds the threshold', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000 });
    // Task started 45 min ago — over the 30-min threshold.
    writeHeartbeatWithTaskStart({ task: 'long-running', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const callArgs = spawnSyncMock.mock.calls[0][1] as string[];
    const body = callArgs.find((a) => a.includes('task stuck'));
    expect(body).toBeDefined();
    expect(body).toContain('long-running');
  });

  it('alert is independent of last_heartbeat refreshes (side-channel-immune)', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000 });
    // Simulate the 2026-05-15 hang shape: task started 45 min ago, but
    // last_heartbeat was refreshed seconds ago by a side-channel send-telegram.
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 5_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    // Existing staleness leg suppressed (fresh last_heartbeat); Path B fires.
    expect(w.isStale).toBe(false);
    expect(w.isTaskStuck).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire when current_task is empty (no work in progress)', () => {
    const w = makeTaskStuckWatcher();
    // Empty task → no task_started_at by Phase 1 contract; watcher must skip.
    writeHeartbeatWithTaskStart({ task: '', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: null });
    w.tick();
    expect(w.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not fire when taskStuckThresholdMs is 0 (disabled)', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 0 });
    writeHeartbeatWithTaskStart({ task: 'task-A', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 10 * 60 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('respects re-alert cadence — second fire requires elapsed time', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000, taskStuckRealertMs: 30 * 60_000 });
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // Tick again 10 min later — task still stuck, within re-alert window, no re-fire.
    advance(10 * 60_000);
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 55 * 60_000 });
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // 30 min after the first alert — re-alert fires.
    advance(21 * 60_000);
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 76 * 60_000 });
    w.tick();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when current_task transitions to a different value', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000 });
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(true);

    // Operator nudges; agent advances to a new task with a fresh stamp.
    advance(5_000);
    writeHeartbeatWithTaskStart({ task: 'next-task', lastHeartbeatAgeMs: 0, taskStartedAgeMs: 0 });
    w.tick();
    expect(w.isTaskStuck).toBe(false);
  });

  it('recovers when current_task clears to empty', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000 });
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(true);
    advance(1_000);
    writeHeartbeatWithTaskStart({ task: '', lastHeartbeatAgeMs: 0, taskStartedAgeMs: null });
    w.tick();
    expect(w.isTaskStuck).toBe(false);
  });

  it('skips silently when task_started_at field is missing (legacy heartbeat)', () => {
    // Synthesize a legacy heartbeat that has current_task but no task_started_at.
    const dir = join(ctxRoot, 'state', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
      agent: AGENT,
      org: 'acme',
      status: 'healthy',
      current_task: 'task-A',
      mode: 'day',
      last_heartbeat: new Date(clock.ms - 60_000).toISOString(),
      loop_interval: '5m',
    }));
    const w = makeTaskStuckWatcher();
    w.tick();
    expect(w.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('emits task_stuck_detected daemon JSONL event when instance+org provided', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000, instanceId: 'test-instance', org: 'acme' });
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    const detected = readDaemonEvents().find((r) => r.event === 'task_stuck_detected');
    expect(detected).toBeDefined();
    expect(detected!.metadata.agent).toBe(AGENT);
    expect(detected!.metadata.task).toBe('wedged');
    expect(detected!.metadata.threshold_seconds).toBe(30 * 60);
  });

  it('handles back-to-back transitions where the new task is also immediately over-threshold', () => {
    // Defensive test: agent transitions from one stuck task to another whose
    // task_started_at is ALSO over-threshold (e.g. fast back-to-back wedges).
    // Recovery emits for the old task, then flagTaskStuck fires for the new
    // task in the SAME tick. Both Telegram alerts go out.
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000, instanceId: 'test-instance', org: 'acme' });
    writeHeartbeatWithTaskStart({ task: 'wedged-A', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // New task, also already 45 min old at observation time.
    advance(1_000);
    writeHeartbeatWithTaskStart({ task: 'wedged-B', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    expect(w.isTaskStuck).toBe(true);
    const events = readDaemonEvents().map((r) => r.event);
    expect(events).toContain('task_stuck_recovered'); // for wedged-A
    expect(events.filter((e) => e === 'task_stuck_detected')).toHaveLength(2); // A + B
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('skips silently when task_started_at is a corrupt non-ISO string', () => {
    const dir = join(ctxRoot, 'state', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
      agent: AGENT,
      org: 'acme',
      status: 'healthy',
      current_task: 'task-A',
      mode: 'day',
      last_heartbeat: new Date(clock.ms - 60_000).toISOString(),
      loop_interval: '5m',
      task_started_at: 'not-a-date',
    }));
    const w = makeTaskStuckWatcher();
    w.tick();
    expect(w.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('emits task_stuck_recovered when task transitions after a stuck alert', () => {
    const w = makeTaskStuckWatcher({ taskStuckThresholdMs: 30 * 60_000, instanceId: 'test-instance', org: 'acme' });
    writeHeartbeatWithTaskStart({ task: 'wedged', lastHeartbeatAgeMs: 60_000, taskStartedAgeMs: 45 * 60_000 });
    w.tick();
    advance(5_000);
    writeHeartbeatWithTaskStart({ task: 'next-task', lastHeartbeatAgeMs: 0, taskStartedAgeMs: 0 });
    w.tick();
    const events = readDaemonEvents().map((r) => r.event);
    expect(events).toContain('task_stuck_recovered');
  });
});
