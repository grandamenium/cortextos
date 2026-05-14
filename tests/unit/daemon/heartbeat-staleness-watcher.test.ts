/**
 * Fleet-resilience plan #2 — heartbeat-staleness watchdog.
 *
 * Drives the watcher with an injectable clock + manual tick() so we never
 * need real timers; the operator-alert Telegram call is short-circuited by
 * the same spawnSync mock pattern used in the cron-dispatch tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
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
    try {
      const { readFileSync, existsSync } = require('fs');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    } catch {
      return [];
    }
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
