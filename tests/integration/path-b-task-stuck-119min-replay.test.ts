/**
 * Path B watchdog verification — re-create the 2026-05-15 119-min hang.
 *
 * Spec: orgs/sb-personal/agents/analyst/specs/theta-wave-candidates/
 *       watchdog-threshold-tuning.md § "Verification when shipped"
 *
 * Scenario:
 *   1. Agent has `current_task` set (engineer was processing a doctor-cron
 *      dispatch). task_started_at stamped at simulated T0.
 *   2. Sibling process (operator + monitoring crons) emits send-telegram
 *      every 5 min — each call refreshes `last_heartbeat` via the side-
 *      channel `refreshHeartbeatTimestamp` path.
 *   3. The agent itself goes silent (no current_task transition, no
 *      `task_completed` event, no heartbeat update).
 *
 * On 2026-05-15 this produced ZERO alerts despite a 119-min outage,
 * because every staleness watcher saw a fresh `last_heartbeat` (refreshed
 * by the sibling pings) and the 60-min standby threshold never tripped.
 *
 * Path B must fire at the configured task-stuck threshold (30 min by
 * default) DESPITE the sibling-process refreshes, because it reads
 * `task_started_at` which the side-channel never touches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

import { HeartbeatStalenessWatcher } from '../../src/daemon/heartbeat-staleness-watcher';
import { updateHeartbeat } from '../../src/bus/heartbeat';
import { logEvent } from '../../src/bus/event';
import type { BusPaths, Heartbeat } from '../../src/types';

const AGENT = 'engineer';
const ORG = 'sb-personal';

let ctxRoot: string;
let frameworkRoot: string;
let clock: { ms: number };

const ORIG_ENV_CHAT = process.env.CTX_OPERATOR_CHAT_ID;
const ORIG_ENV_TOKEN = process.env.CTX_OPERATOR_BOT_TOKEN;

function makePaths(): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', AGENT),
    inflight: join(ctxRoot, 'inflight', AGENT),
    processed: join(ctxRoot, 'processed', AGENT),
    logDir: join(ctxRoot, 'logs', AGENT),
    stateDir: join(ctxRoot, 'state', AGENT),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', ORG, 'analytics'),
    heartbeatDir: join(ctxRoot, 'heartbeats'),
  };
}

function readHeartbeat(): Heartbeat {
  return JSON.parse(readFileSync(join(ctxRoot, 'state', AGENT, 'heartbeat.json'), 'utf-8'));
}

function advance(ms: number): void {
  clock.ms += ms;
  vi.setSystemTime(clock.ms);
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-pathb-replay-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-pathb-replay-fw-'));
  clock = { ms: Date.parse('2026-05-15T13:25:00Z') }; // matches the real-incident start
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

describe('Path B watchdog — 2026-05-15 119-min hang replay', () => {
  it('fires task_stuck alert at the configured threshold despite sibling-process heartbeat refreshes', () => {
    const paths = makePaths();
    // T0: agent picks up a dispatched task and stamps current_task.
    updateHeartbeat(paths, AGENT, 'online', {
      org: ORG,
      currentTask: 'doctor-cron-false-positive-fixes',
    });
    const t0 = readHeartbeat();
    expect(t0.current_task).toBe('doctor-cron-false-positive-fixes');
    expect(t0.task_started_at).toBe(t0.last_heartbeat);

    // The active-class watcher (engineer is active-class → 10 min staleness).
    // taskStuckThresholdMs is 30 min (default for Path B per Phase 2 wiring).
    // The classical staleness leg should NOT fire here because the sibling-
    // process pings keep last_heartbeat fresh; Path B must catch this case.
    const watcher = new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      thresholdMs: 10 * 60_000,
      realertMs: 30 * 60_000,
      taskStuckThresholdMs: 30 * 60_000,
      taskStuckRealertMs: 30 * 60_000,
      logger: () => {},
      now: () => clock.ms,
      instanceId: 'test-instance',
      org: ORG,
    });

    // Simulate the hang: agent doesn't update its own heartbeat, but a
    // sibling process emits a Telegram every 5 min. Each emit goes through
    // logEvent (action/message_sent) which refreshes last_heartbeat via
    // `refreshHeartbeatTimestamp` — the exact side-channel that fooled the
    // 60-min standby threshold on 2026-05-15.
    // Tick the watcher every minute. Path B should fire at minute 31 (just
    // past the 30-min threshold).
    let firedAtMinute: number | null = null;
    for (let minute = 1; minute <= 60; minute++) {
      advance(60_000);
      // Sibling-process Telegram every 5 min.
      if (minute % 5 === 0) {
        logEvent(paths, AGENT, ORG, 'action', 'telegram_sent', 'info', {
          to_chat_id: '12345',
          source: 'sibling-process',
        });
      }
      watcher.tick();
      if (watcher.isTaskStuck && firedAtMinute === null) {
        firedAtMinute = minute;
      }
    }

    // Verification 1: Path B fires at or just after the 30-min threshold.
    expect(firedAtMinute).not.toBeNull();
    expect(firedAtMinute).toBeGreaterThanOrEqual(30);
    expect(firedAtMinute).toBeLessThanOrEqual(32);

    // Verification 2: even after 60 minutes of side-channel refreshes, the
    // existing staleness leg is NOT firing — last_heartbeat is fresh.
    expect(watcher.isStale).toBe(false);

    // Verification 3: task_started_at on disk has NOT moved despite the
    // sibling-process refreshes (the side-channel writes don't touch it).
    const t60 = readHeartbeat();
    expect(t60.task_started_at).toBe(t0.task_started_at);
    expect(new Date(t60.last_heartbeat).getTime())
      .toBeGreaterThan(new Date(t0.last_heartbeat).getTime());

    // Verification 4: a task_stuck Telegram was attempted (spawnSync
    // dispatched the curl). Pre-Path-B this would have been 0.
    expect(spawnSyncMock).toHaveBeenCalled();
    const curlBodies = spawnSyncMock.mock.calls
      .map((call) => (call[1] as string[] | undefined))
      .filter((args): args is string[] => Array.isArray(args))
      .flat()
      .filter((arg) => typeof arg === 'string' && arg.includes('task stuck'));
    expect(curlBodies.length).toBeGreaterThanOrEqual(1);
    expect(curlBodies[0]).toContain('doctor-cron-false-positive-fixes');

    // Verification 5: JSONL event under _daemon for downstream consumers.
    const today = new Date(clock.ms).toISOString().slice(0, 10);
    const eventFile = join(ctxRoot, 'orgs', ORG, 'analytics', 'events', '_daemon', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);
    const events = readFileSync(eventFile, 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const stuckEvents = events.filter((e) => e.event === 'task_stuck_detected');
    expect(stuckEvents.length).toBeGreaterThanOrEqual(1);
    expect(stuckEvents[0].metadata.agent).toBe(AGENT);
    expect(stuckEvents[0].metadata.task).toBe('doctor-cron-false-positive-fixes');
  });

  it('produces ZERO alerts when Path B is disabled — confirms classical staleness leg still misses the case', () => {
    // Same scenario, but taskStuckThresholdMs=0 (Path B off). Reproduces the
    // pre-fix state: 60 minutes of side-channel pings, no alert.
    const paths = makePaths();
    updateHeartbeat(paths, AGENT, 'online', {
      org: ORG,
      currentTask: 'doctor-cron-false-positive-fixes',
    });

    const watcher = new HeartbeatStalenessWatcher({
      agentName: AGENT,
      ctxRoot,
      frameworkRoot,
      thresholdMs: 10 * 60_000,
      realertMs: 30 * 60_000,
      taskStuckThresholdMs: 0, // Path B disabled
      logger: () => {},
      now: () => clock.ms,
      instanceId: 'test-instance',
      org: ORG,
    });

    for (let minute = 1; minute <= 60; minute++) {
      advance(60_000);
      if (minute % 5 === 0) {
        logEvent(paths, AGENT, ORG, 'action', 'telegram_sent', 'info', { source: 'sibling-process' });
      }
      watcher.tick();
    }

    // No staleness alert (last_heartbeat stays fresh), no task-stuck alert
    // (leg disabled). Reproduces the 2026-05-15 silence.
    expect(watcher.isStale).toBe(false);
    expect(watcher.isTaskStuck).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
