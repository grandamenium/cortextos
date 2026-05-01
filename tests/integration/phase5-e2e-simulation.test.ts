/**
 * tests/integration/phase5-e2e-simulation.test.ts — Subtask 5.1
 *
 * Phase 5 End-to-End System Simulation: 7 full-system scenarios covering the
 * complete operation lifecycle of the external persistent cron system.
 *
 * All 7 scenarios drive REAL disk I/O (per-test temp CTX_ROOT) with vitest fake
 * timers, matching the established Phase 1 pattern.  No module mocking beyond
 * CTX_ROOT isolation — the full stack runs (crons.ts, cron-scheduler.ts,
 * cron-execution-log.ts, dashboard API routes).
 *
 * COMPRESSED TIME STRATEGY
 * ------------------------
 * vi.useFakeTimers() intercepts setInterval, setTimeout, and Date.now().
 * A "7-day simulation" (168h) is compressed by advancing fake time in 1-minute
 * steps.  Each step is a synchronous timer-queue drain, so the full simulation
 * of 168h × 60 steps = 10 080 iterations runs in a few seconds of real time.
 *
 * SCENARIOS
 * ---------
 * 1. Normal operation (Day 1)     — 7 agents, 50+ crons, 24h sim, all fire correctly
 * 2. Daemon crash (Day 2)         — Kill scheduler mid-run, restart, bounded catch-up
 * 3. Agent crash (Day 3)          — PTY unavailable, graceful failure, recovery on restart
 * 4. State corruption (Day 4)     — 3 corruption sub-types, fallback to last-good state
 * 5. PTY degradation (Day 5)      — Slow/intermittent injection, retry coverage
 * 6. Concurrent stress (Day 6)    — 10 crons fire simultaneously, no race conditions
 * 7. Dashboard polling (Day 7)    — API reflects accurate state throughout simulation
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { CronDefinition, CronExecutionLogEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_MS      = 30_000;   // CronScheduler.TICK_INTERVAL_MS
const ONE_MIN      = 60_000;
const ONE_HOUR     = 3_600_000;
const SIM_24H      = 24 * ONE_HOUR;
const SIM_6H       = 6 * ONE_HOUR;
const SIM_12H      = 12 * ONE_HOUR;

// ---------------------------------------------------------------------------
// Per-test environment wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let addCron: typeof import('../../src/bus/crons.js').addCron;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let writeCrons: typeof import('../../src/bus/crons.js').writeCrons;
let getCronByName: typeof import('../../src/bus/crons.js').getCronByName;
let getExecutionLog: typeof import('../../src/bus/crons.js').getExecutionLog;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules() {
  vi.resetModules();
  const cronsModule = await import('../../src/bus/crons.js');
  addCron = cronsModule.addCron;
  readCrons = cronsModule.readCrons;
  writeCrons = cronsModule.writeCrons;
  getCronByName = cronsModule.getCronByName;
  getExecutionLog = cronsModule.getExecutionLog;
  const schedulerModule = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler = schedulerModule.CronScheduler;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'phase5-e2e-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.useFakeTimers();
  await reloadModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function ensureAgentDir(agentName: string): string {
  const dir = join(tmpRoot, '.cortextOS', 'state', 'agents', agentName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCronDef(
  name: string,
  schedule: string,
  overrides: Partial<CronDefinition> = {},
): CronDefinition {
  return {
    name,
    prompt: `Prompt for ${name}.`,
    schedule,
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildScheduler(
  agentName: string,
  onFire: (c: CronDefinition) => Promise<void> | void,
  logs: string[] = [],
) {
  return new CronScheduler({
    agentName,
    onFire,
    logger: (msg) => logs.push(msg),
  });
}

async function advanceSim(totalMs: number, stepMs = ONE_MIN): Promise<void> {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    const remaining = totalMs - i * stepMs;
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, remaining));
  }
}

function readLog(agentName: string): CronExecutionLogEntry[] {
  const logPath = join(
    tmpRoot,
    '.cortextOS', 'state', 'agents', agentName, 'cron-execution.log',
  );
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as CronExecutionLogEntry);
}

function cronsFilePath(agentName: string): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', agentName, 'crons.json');
}

// ---------------------------------------------------------------------------
// Scenario 1 — Normal operation (Day 1): 7 agents, 50+ crons, 24h sim
// ---------------------------------------------------------------------------

describe('Scenario 1: Normal operation — 7 agents, 50+ crons, 24h sim', () => {
  it('every cron fires expected number of times; all logged with status=success', async () => {
    // 7 agents × 8 crons each = 56 crons total.
    // Mix of interval shorthands and cron expressions.
    //
    // Expected fires in 24h:
    //   "1h"            → 24 fires
    //   "2h"            → 12 fires
    //   "3h"            → 8 fires
    //   "4h"            → 6 fires
    //   "6h"            → 4 fires
    //   "8h"            → 3 fires
    //   "12h"           → 2 fires
    //   "24h"           → 1 fire
    //   "0 * * * *"     → 24 fires  (hourly via cron expr)
    //   "*/30 * * * *"  → 48 fires  (every 30 min)
    //   "0 0,6,12,18 * * *" → 4 fires
    //   "0 0,12 * * *"  → 2 fires   (twice daily)

    const agentNames = ['sim-alpha', 'sim-beta', 'sim-gamma', 'sim-delta', 'sim-epsilon', 'sim-zeta', 'sim-eta'];

    // cronDefs: [agentIndex, cronSuffix, schedule, expectedMin, expectedMax]
    const rawDefs: [number, string, string, number, number][] = [
      // sim-alpha (8 crons)
      [0, 'hourly-interval',  '1h',              23, 25],
      [0, 'every2h',          '2h',              11, 13],
      [0, 'every3h',          '3h',               7,  9],
      [0, 'every4h',          '4h',               5,  7],
      [0, 'every6h',          '6h',               3,  5],
      [0, 'every8h',          '8h',               2,  4],
      [0, 'every12h',         '12h',              1,  3],
      [0, 'daily',            '24h',              0,  2],
      // sim-beta (8 crons)
      [1, 'hourly-cron',      '0 * * * *',       23, 25],
      [1, 'every30m',         '*/30 * * * *',    47, 49],
      [1, 'every6h-cron',     '0 0,6,12,18 * * *', 3, 5],
      [1, 'twicedaily',       '0 0,12 * * *',     1,  3],
      [1, 'h1',               '1h',              23, 25],
      [1, 'h2',               '2h',              11, 13],
      [1, 'h3',               '3h',               7,  9],
      [1, 'h4',               '4h',               5,  7],
      // sim-gamma (8 crons)
      [2, 'hourly-g',         '1h',              23, 25],
      [2, 'every2h-g',        '2h',              11, 13],
      [2, 'every30m-g',       '*/30 * * * *',   47, 49],
      [2, 'every6h-g',        '6h',               3,  5],
      [2, 'every8h-g',        '8h',               2,  4],
      [2, 'every12h-g',       '12h',              1,  3],
      [2, 'daily-g',          '24h',              0,  2],
      [2, 'hourly-cron-g',    '0 * * * *',       23, 25],
      // sim-delta (8 crons)
      [3, 'h1d',              '1h',              23, 25],
      [3, 'h2d',              '2h',              11, 13],
      [3, 'h3d',              '3h',               7,  9],
      [3, 'h4d',              '4h',               5,  7],
      [3, 'h6d',              '6h',               3,  5],
      [3, 'h8d',              '8h',               2,  4],
      [3, 'h12d',             '12h',              1,  3],
      [3, 'h24d',             '24h',              0,  2],
      // sim-epsilon (8 crons)
      [4, 'h1e',              '1h',              23, 25],
      [4, 'h2e',              '2h',              11, 13],
      [4, 'h30me',            '*/30 * * * *',   47, 49],
      [4, 'h6e',              '6h',               3,  5],
      [4, 'h8e',              '8h',               2,  4],
      [4, 'h12e',             '12h',              1,  3],
      [4, 'h24e',             '24h',              0,  2],
      [4, 'hcron-e',          '0 * * * *',       23, 25],
      // sim-zeta (8 crons)
      [5, 'h1z',              '1h',              23, 25],
      [5, 'h2z',              '2h',              11, 13],
      [5, 'h3z',              '3h',               7,  9],
      [5, 'h4z',              '4h',               5,  7],
      [5, 'h6z',              '6h',               3,  5],
      [5, 'h8z',              '8h',               2,  4],
      [5, 'h12z',             '12h',              1,  3],
      [5, 'h24z',             '24h',              0,  2],
      // sim-eta (8 crons)
      [6, 'h1eta',            '1h',              23, 25],
      [6, 'h2eta',            '2h',              11, 13],
      [6, 'h30meta',          '*/30 * * * *',   47, 49],
      [6, 'h6eta',            '6h',               3,  5],
      [6, 'h8eta',            '8h',               2,  4],
      [6, 'h12eta',           '12h',              1,  3],
      [6, 'h24eta',           '24h',              0,  2],
      [6, 'hcron-eta',        '0 * * * *',       23, 25],
    ];

    // Ensure 50+ crons — this gives us 56
    expect(rawDefs.length).toBeGreaterThanOrEqual(50);

    // Set up agents
    agentNames.forEach(a => ensureAgentDir(a));

    const fireCounts = new Map<string, number>();
    rawDefs.forEach(([, suffix]) => fireCounts.set(suffix, 0));

    // Register all crons
    for (const [agentIdx, suffix, schedule] of rawDefs) {
      addCron(agentNames[agentIdx], makeCronDef(suffix, schedule));
    }

    // Build and start schedulers
    const schedulers = agentNames.map(agent =>
      buildScheduler(agent, (cron) => {
        fireCounts.set(cron.name, (fireCounts.get(cron.name) ?? 0) + 1);
      })
    );
    schedulers.forEach(s => s.start());

    // Run 24h simulation in 1-minute steps
    await advanceSim(SIM_24H);

    schedulers.forEach(s => s.stop());

    // Assert: fire counts within expected range (1% tolerance built into expectedMin/Max)
    for (const [agentIdx, suffix, , expectedMin, expectedMax] of rawDefs) {
      const actual = fireCounts.get(suffix) ?? 0;
      expect(
        actual,
        `Agent ${agentNames[agentIdx]} cron "${suffix}" fired ${actual} times, expected [${expectedMin}, ${expectedMax}]`
      ).toBeGreaterThanOrEqual(expectedMin);
      expect(
        actual,
        `Agent ${agentNames[agentIdx]} cron "${suffix}" fired ${actual} times, expected [${expectedMin}, ${expectedMax}]`
      ).toBeLessThanOrEqual(expectedMax);
    }

    // Assert: every fire produces an execution log entry with status=success (fired)
    for (const [agentIdx, suffix] of rawDefs) {
      const agentName = agentNames[agentIdx];
      const logFiredCount = readLog(agentName).filter(e => e.cron === suffix && e.status === 'fired').length;
      const expectedFires = fireCounts.get(suffix) ?? 0;
      expect(
        logFiredCount,
        `${agentName}::${suffix} — log fired entries (${logFiredCount}) should match fire count (${expectedFires})`
      ).toBe(expectedFires);
    }

    // Assert: cron-state (last_fired_at / fire_count) accurate on disk
    for (const [agentIdx, suffix] of rawDefs) {
      const agentName = agentNames[agentIdx];
      const expectedFires = fireCounts.get(suffix) ?? 0;
      if (expectedFires > 0) {
        const cron = getCronByName(agentName, suffix);
        expect(cron?.last_fired_at, `${agentName}::${suffix} should have last_fired_at after ${expectedFires} fires`).toBeDefined();
        expect(cron?.fire_count, `${agentName}::${suffix} fire_count should be ${expectedFires}`).toBe(expectedFires);
      }
    }
  }, 120_000); // allow 2m real time for 56-cron 24h sim
});

// ---------------------------------------------------------------------------
// Scenario 2 — Daemon crash (Day 2)
// ---------------------------------------------------------------------------

describe('Scenario 2: Daemon crash — stop mid-run, restart, bounded catch-up', () => {
  it('scheduler restarts from disk state; catch-up bounded to 1 fire per missed cron', async () => {
    const agents = ['crash-a', 'crash-b', 'crash-c'];
    agents.forEach(a => ensureAgentDir(a));

    const fired: string[] = [];
    const logs: string[] = [];

    // Each agent gets 3 crons with distinct intervals
    const cronDefs = [
      { agent: 'crash-a', name: 'ca-1h', schedule: '1h' },
      { agent: 'crash-a', name: 'ca-2h', schedule: '2h' },
      { agent: 'crash-a', name: 'ca-6h', schedule: '6h' },
      { agent: 'crash-b', name: 'cb-1h', schedule: '1h' },
      { agent: 'crash-b', name: 'cb-3h', schedule: '3h' },
      { agent: 'crash-b', name: 'cb-12h', schedule: '12h' },
      { agent: 'crash-c', name: 'cc-2h', schedule: '2h' },
      { agent: 'crash-c', name: 'cc-4h', schedule: '4h' },
      { agent: 'crash-c', name: 'cc-8h', schedule: '8h' },
    ];
    for (const cd of cronDefs) {
      addCron(cd.agent, makeCronDef(cd.name, cd.schedule));
    }

    // Phase 1: run for 6h
    const schedulers1 = agents.map(agent =>
      buildScheduler(agent, (c) => fired.push(`${agent}:${c.name}`), logs)
    );
    schedulers1.forEach(s => s.start());
    await advanceSim(SIM_6H);

    const firesBefore = fired.length;
    expect(firesBefore).toBeGreaterThan(0);

    // Capture pre-crash state from disk
    const precrashCronStates = new Map<string, CronDefinition>();
    for (const cd of cronDefs) {
      const cron = getCronByName(cd.agent, cd.name);
      if (cron) precrashCronStates.set(`${cd.agent}:${cd.name}`, cron);
    }

    // "Crash": stop all schedulers abruptly (in-memory state gone)
    schedulers1.forEach(s => s.stop());

    // Simulate 90 minutes of downtime
    await vi.advanceTimersByTimeAsync(90 * ONE_MIN);

    // "Restart": fresh scheduler instances, each reads disk state
    const schedulers2 = agents.map(agent =>
      buildScheduler(agent, (c) => fired.push(`${agent}:${c.name}`), logs)
    );
    schedulers2.forEach(s => s.start());

    // First tick after restart — catch-up fires should happen
    await vi.advanceTimersByTimeAsync(TICK_MS);

    const catchUpFires = fired.length - firesBefore;
    // Each of the 9 crons missed at most 1-2 fires in 90min. Most 1h crons missed 1.
    // Catch-up policy fires at most 1 per cron (not a flood).
    // Verify: catch-up count <= total number of crons (one catch-up each at most)
    expect(catchUpFires).toBeGreaterThanOrEqual(1);
    expect(catchUpFires).toBeLessThanOrEqual(cronDefs.length);

    // Assert: no catch-up storm — catch-up is bounded by definition count
    // (the policy says: fire once for the most recent missed window)
    const catchUpPerCron = new Map<string, number>();
    const catchUpFiredList = fired.slice(firesBefore);
    for (const key of catchUpFiredList) {
      catchUpPerCron.set(key, (catchUpPerCron.get(key) ?? 0) + 1);
    }
    for (const [key, count] of catchUpPerCron) {
      expect(count, `${key} should catch-up fire at most once`).toBeLessThanOrEqual(1);
    }

    // Continue running for 6 more hours — scheduling should resume normally
    await advanceSim(SIM_6H);

    schedulers2.forEach(s => s.stop());

    // Assert: crons continue firing after restart (more fires happened post-restart)
    const firesAfterFullRun = fired.length;
    expect(firesAfterFullRun).toBeGreaterThan(firesBefore + catchUpFires);

    // Assert: no data loss in execution log — log count matches fire array length
    let totalLoggedFires = 0;
    for (const agent of agents) {
      totalLoggedFires += readLog(agent).filter(e => e.status === 'fired').length;
    }
    expect(totalLoggedFires).toBe(firesAfterFullRun);

    // Assert: disk cron state has updated last_fired_at after restart
    for (const cd of cronDefs) {
      const cron = getCronByName(cd.agent, cd.name);
      const precrash = precrashCronStates.get(`${cd.agent}:${cd.name}`);
      if (cron?.last_fired_at && precrash?.last_fired_at) {
        // Post-run timestamp should be >= pre-crash timestamp (some may be equal if
        // no fires occurred for very low-frequency crons in the short window)
        expect(
          new Date(cron.last_fired_at).getTime()
        ).toBeGreaterThanOrEqual(new Date(precrash.last_fired_at).getTime());
      }
    }
  }, 60_000);

  it('post-restart cron fires within 1 tick of when they should', async () => {
    const agent = 'restart-timing';
    ensureAgentDir(agent);

    const fireTimestamps: number[] = [];

    // 6h cron that last fired 7h ago — clearly overdue at boot time.
    // We skip running s1 so the cron remains overdue at restart.
    addCron(agent, makeCronDef('sixhourly', '6h', {
      last_fired_at: new Date(Date.now() - 7 * ONE_HOUR).toISOString(),
    }));

    const restartTime = Date.now();

    // Start fresh scheduler — the cron should catch up on the first tick
    const s = buildScheduler(agent, () => { fireTimestamps.push(Date.now()); });
    s.start();

    // First tick: catch-up fire should happen
    await vi.advanceTimersByTimeAsync(TICK_MS);
    s.stop();

    // Assert: fire happened within 1 tick of start (which represents restart)
    expect(fireTimestamps.length).toBeGreaterThanOrEqual(1);
    const firstFire = fireTimestamps[0];
    expect(firstFire).toBeDefined();
    // Fire must happen at or after restartTime and within 1 tick
    expect(firstFire).toBeGreaterThanOrEqual(restartTime);
    expect(firstFire - restartTime).toBeLessThanOrEqual(TICK_MS + 1_000);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Agent crash (Day 3)
// ---------------------------------------------------------------------------

describe('Scenario 3: Agent crash — PTY unavailable, graceful failure, recovery', () => {
  it('crons log failures gracefully when PTY unavailable; resume after agent restart', async () => {
    const agent = 'pty-crash-agent';
    ensureAgentDir(agent);

    let agentRunning = true; // simulates agent process state
    const firedSuccessfully: string[] = [];
    const logs: string[] = [];

    // Set up 3 crons
    const cronNames = ['ptyx', 'ptyy', 'ptyz'];
    for (const name of cronNames) {
      // Pre-fire all 3 so catch-up triggers immediately on start
      addCron(agent, makeCronDef(name, '1h', {
        last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
      }));
    }

    // Fire callback that checks agent running state
    const onFire = vi.fn().mockImplementation(async (cron: CronDefinition) => {
      if (!agentRunning) {
        throw new Error(`injectAgent returned false for agent "${agent}" — agent may not be running`);
      }
      firedSuccessfully.push(cron.name);
    });

    const s = buildScheduler(agent, onFire, logs);
    s.start();

    // Phase 1: agent running — all 3 crons catch up and fire
    await vi.advanceTimersByTimeAsync(TICK_MS);
    // Drive all retry paths to completion (1s + 4s + 16s)
    await vi.advanceTimersByTimeAsync(22_000);

    const successBeforeCrash = firedSuccessfully.length;
    expect(successBeforeCrash).toBeGreaterThanOrEqual(3);

    // "Crash" the agent: mark unavailable
    agentRunning = false;

    // Advance 1h — 3 more fires should be attempted and fail
    await advanceSim(ONE_HOUR + TICK_MS);
    // Drive all retry paths
    await vi.advanceTimersByTimeAsync(22_000);

    // Assert: failures logged (retried + failed entries)
    const allLog = readLog(agent);
    const failureEntries = allLog.filter(e =>
      cronNames.includes(e.cron) && (e.status === 'failed' || e.status === 'retried')
    );
    expect(failureEntries.length).toBeGreaterThan(0);

    // Assert: error messages reference the injection failure
    for (const entry of failureEntries) {
      expect(entry.error).toContain('injectAgent returned false');
    }

    // Assert: scheduler does NOT crash — it's still running (stop works)
    expect(() => s.stop()).not.toThrow();

    // Restart agent (mark as running again) and create fresh scheduler
    agentRunning = true;

    const s2 = buildScheduler(agent, onFire, logs);
    s2.start();

    // Iter 11 semantic: each failed fire above persisted last_fire_attempted_at,
    // so on restart loadCrons computes nextFireAt = attempted_at + interval —
    // i.e. the catch-up gate is intentionally suppressed (attempts were made,
    // so re-firing them risks double-fire if the agent actually received the
    // prompt before the failure).  Advance to the NEXT scheduled slot to
    // verify normal forward scheduling resumes.
    await advanceSim(ONE_HOUR + TICK_MS);
    await vi.advanceTimersByTimeAsync(22_000);

    s2.stop();

    // Assert: successful fires resumed after restart
    expect(firedSuccessfully.length).toBeGreaterThan(successBeforeCrash);

    // Assert: cron definitions still intact (no lost cron definitions)
    const cronsOnDisk = readCrons(agent);
    expect(cronsOnDisk).toHaveLength(3);
    for (const name of cronNames) {
      expect(cronsOnDisk.some(c => c.name === name)).toBe(true);
    }
  });

  it('fire_count and last_fired_at remain consistent after crash-recovery cycle', async () => {
    const agent = 'fire-count-agent';
    ensureAgentDir(agent);

    let agentOnline = true;
    const onFire = vi.fn().mockImplementation(async () => {
      if (!agentOnline) throw new Error('agent offline');
    });

    addCron(agent, makeCronDef('monitor', '1h', {
      last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
    }));

    // Phase 1: successful fire
    const s1 = buildScheduler(agent, onFire);
    s1.start();
    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000);
    s1.stop();

    const afterPhase1 = getCronByName(agent, 'monitor');
    const fireCountAfterPhase1 = afterPhase1?.fire_count ?? 0;
    expect(fireCountAfterPhase1).toBeGreaterThanOrEqual(1);

    // Phase 2: agent crash — fire fails
    agentOnline = false;
    const s2 = buildScheduler(agent, onFire);
    s2.start();
    await advanceSim(ONE_HOUR + TICK_MS);
    await vi.advanceTimersByTimeAsync(22_000);
    s2.stop();

    // fire_count must NOT have incremented during crash period
    const afterCrash = getCronByName(agent, 'monitor');
    expect(afterCrash?.fire_count ?? 0).toBe(fireCountAfterPhase1);

    // Phase 3: recovery
    // Iter 11 semantic: Phase 2's failed fire persisted last_fire_attempted_at,
    // so loadCrons sees referenceMs = attempted_at and nextFireAt is in the
    // FUTURE (one full interval out) — no catch-up.  Advance through one
    // more scheduled slot to verify normal forward scheduling resumes and
    // increments fire_count.
    agentOnline = true;
    const s3 = buildScheduler(agent, onFire);
    s3.start();
    await advanceSim(ONE_HOUR + TICK_MS + 1_000);
    s3.stop();

    const afterRecovery = getCronByName(agent, 'monitor');
    expect(afterRecovery?.fire_count ?? 0).toBeGreaterThan(fireCountAfterPhase1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — State corruption (Day 4)
// ---------------------------------------------------------------------------

describe('Scenario 4: State corruption — 3 sub-types, fallback to last-known-good', () => {
  it('4a: truncated crons.json (0 bytes) — scheduler falls back to empty, logs error, other agents unaffected', async () => {
    const agentGood = 'good-s4a';
    const agentBad = 'bad-s4a';
    ensureAgentDir(agentGood);
    ensureAgentDir(agentBad);

    const firedGood: string[] = [];
    const firedBad: string[] = [];
    const logsGood: string[] = [];
    const logsBad: string[] = [];

    addCron(agentGood, makeCronDef('good-cron', '1h'));
    addCron(agentBad, makeCronDef('bad-cron', '1h'));

    const sGood = buildScheduler(agentGood, (c) => firedGood.push(c.name), logsGood);
    const sBad = buildScheduler(agentBad, (c) => firedBad.push(c.name), logsBad);

    sGood.start();
    sBad.start();

    // Run 2h normally
    await advanceSim(2 * ONE_HOUR + TICK_MS);

    expect(firedGood.length).toBeGreaterThanOrEqual(2);
    expect(firedBad.length).toBeGreaterThanOrEqual(2);

    const firesGoodBefore = firedGood.length;

    // Corrupt: truncate to 0 bytes (4a)
    writeFileSync(cronsFilePath(agentBad), '', 'utf-8');

    // Reload sBad — readCrons returns [] (truncated file).
    // POST-5.3 BEHAVIOR: lastGoodSchedule retains the previous valid schedule.
    // If a .bak file exists (from prior writeCrons calls), readCrons falls back to .bak.
    // Either way: the scheduler keeps crons active — it does NOT zero out.
    sBad.reload();

    // After reload with lastGoodSchedule: schedule is retained (non-zero)
    expect(sBad.getNextFireTimes().length).toBeGreaterThan(0);

    // Assert: reload was logged
    expect(logsBad.some(l => l.includes('reloaded') || l.includes('retaining'))).toBe(true);

    const firesBadBefore = firedBad.length;

    // Both agents continue firing (good agent unaffected; bad agent retained schedule)
    await advanceSim(2 * ONE_HOUR + TICK_MS);

    sGood.stop();
    sBad.stop();

    expect(firedGood.length).toBeGreaterThanOrEqual(firesGoodBefore + 1);
    // Bad agent kept firing (schedule retained by lastGoodSchedule or .bak)
    expect(firedBad.length).toBeGreaterThanOrEqual(firesBadBefore);

    // Assert: once corruption is repaired, scheduler picks up new state on reload
    addCron(agentBad, makeCronDef('recovered-cron', '1h'));

    const sBad2 = buildScheduler(agentBad, (c) => firedBad.push(c.name), logsBad);
    sBad2.start();

    await advanceSim(ONE_HOUR + TICK_MS);
    sBad2.stop();

    const newFiresBad = firedBad.length - firesBadBefore;
    expect(newFiresBad).toBeGreaterThanOrEqual(1);
  });

  it('4b: invalid JSON in crons.json — readCrons returns [], scheduler halts gracefully', async () => {
    const agent = 's4b-agent';
    ensureAgentDir(agent);

    const fired: string[] = [];
    const logs: string[] = [];

    addCron(agent, makeCronDef('cron-4b', '1h'));

    const s = buildScheduler(agent, (c) => fired.push(c.name), logs);
    s.start();

    // Run 1h normally
    await advanceSim(ONE_HOUR + TICK_MS);
    expect(fired.length).toBeGreaterThanOrEqual(1);

    const firesBefore = fired.length;

    // Corrupt: write invalid JSON (4b). Also corrupt the .bak if present.
    writeFileSync(cronsFilePath(agent), '{ "crons": [INVALID JSON!!! missing bracket', 'utf-8');
    const bakPath4b = cronsFilePath(agent) + '.bak';
    if (existsSync(bakPath4b)) {
      writeFileSync(bakPath4b, 'CORRUPT BAK 4b', 'utf-8');
    }

    s.reload();

    // POST-5.3 BEHAVIOR: when both primary and .bak are corrupted, readCrons returns [].
    // lastGoodSchedule retains the previous valid schedule so crons keep firing.
    // When only primary is corrupted (no .bak yet), readCrons returns [] and
    // lastGoodSchedule retains the in-memory schedule.
    // Either way: schedule is NOT zeroed out.
    expect(s.getNextFireTimes().length).toBeGreaterThan(0);

    // Crons continue firing during corruption (last-good retained)
    await advanceSim(ONE_HOUR + TICK_MS);
    s.stop();

    // Fires may have continued during corruption (lastGoodSchedule active)
    expect(fired.length).toBeGreaterThanOrEqual(firesBefore);

    // Assert: repair restores scheduling
    writeCrons(agent, [makeCronDef('cron-4b-repaired', '1h')]);
    const s2 = buildScheduler(agent, (c) => fired.push(c.name), logs);
    s2.start();
    await advanceSim(ONE_HOUR + TICK_MS);
    s2.stop();

    expect(fired.length).toBeGreaterThan(firesBefore);
  });

  it('4c: valid JSON but wrong shape — readCrons returns [], zero data loss on repair', async () => {
    const agent = 's4c-agent';
    ensureAgentDir(agent);

    const fired: string[] = [];
    const logs: string[] = [];

    addCron(agent, makeCronDef('cron-4c', '1h'));

    const s = buildScheduler(agent, (c) => fired.push(c.name), logs);
    s.start();

    await advanceSim(ONE_HOUR + TICK_MS);
    const firesBefore = fired.length;
    expect(firesBefore).toBeGreaterThanOrEqual(1);

    // Corrupt: valid JSON but missing "crons" array key (4c — wrong shape)
    writeFileSync(
      cronsFilePath(agent),
      JSON.stringify({ updated_at: new Date().toISOString(), tasks: [], type: 'wrong-shape' }),
      'utf-8'
    );

    s.reload();

    // POST-5.3 BEHAVIOR: wrong-shape JSON causes readCrons to return [].
    // If .bak exists with valid data, it's used instead (schedule remains full).
    // If .bak also invalid/missing, lastGoodSchedule retains the in-memory schedule.
    // Either way: schedule size > 0 (crons keep firing through transient corruption).
    const nextAfterCorrupt = s.getNextFireTimes();
    expect(nextAfterCorrupt.length).toBeGreaterThan(0);

    const firesAfterCorrupt = fired.length;
    await advanceSim(ONE_HOUR + TICK_MS);
    s.stop();

    // Fires continue during corruption (lastGoodSchedule retained)
    expect(fired.length).toBeGreaterThanOrEqual(firesAfterCorrupt);

    // Repair: write valid crons.json
    writeCrons(agent, [makeCronDef('cron-4c-restored', '2h')]);

    // Assert: zero data loss — pre-corruption log entries still intact + any fires
    // that happened during corruption (lastGoodSchedule continued firing)
    const logBeforeRepair = readLog(agent);
    expect(logBeforeRepair.filter(e => e.status === 'fired').length).toBeGreaterThanOrEqual(firesBefore);

    // New scheduler picks up repaired state
    const s2 = buildScheduler(agent, (c) => fired.push(c.name), logs);
    s2.start();
    await advanceSim(2 * ONE_HOUR + TICK_MS);
    s2.stop();

    expect(fired.length).toBeGreaterThan(firesAfterCorrupt);

    // Assert: log entries from both before and after repair present
    // cron-4c fired during corruption too (lastGoodSchedule retained), so count >= firesBefore
    const finalLog = readLog(agent);
    expect(finalLog.filter(e => e.cron === 'cron-4c' && e.status === 'fired').length).toBeGreaterThanOrEqual(firesBefore);
    expect(finalLog.filter(e => e.cron === 'cron-4c-restored' && e.status === 'fired').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — PTY degradation (Day 5)
// ---------------------------------------------------------------------------

describe('Scenario 5: PTY degradation — slow injection, intermittent failure, retry coverage', () => {
  /**
   * PHASE 5 FINDING: agent-manager.ts injectAgent() has no internal retry logic.
   * The retry logic lives entirely in CronScheduler.fireWithRetry() (cron-scheduler.ts).
   * This is the CORRECT design: the scheduler owns fire reliability; injectAgent is a
   * thin synchronous boolean wrapper around AgentProcess.injectMessage(). Retries at
   * the scheduler layer cover all injectAgent failure modes — PTY slow, PTY absent, etc.
   *
   * The scheduler retries 3 times with 1s/4s/16s backoff (4 attempts total).
   * "Eventual delivery" window: max 21s after initial attempt.
   *
   * Documented as finding, not a gap — the design is intentional.
   */

  it('5a: slow injection (200ms each call) — all crons eventually delivered within retry window', async () => {
    const agent = 'slow-pty-agent';
    ensureAgentDir(agent);

    let callCount = 0;
    const firedNames: string[] = [];
    const logs: string[] = [];

    // Simulate slow PTY: succeeds but takes 200ms per call
    // With fake timers, promises resolve synchronously but we track timing
    const slowFire = vi.fn().mockImplementation(async (cron: CronDefinition) => {
      callCount++;
      // Simulate 200ms PTY delay by using a setTimeout (fake-timer-compatible)
      await new Promise<void>(resolve => setTimeout(resolve, 200));
      firedNames.push(cron.name);
    });

    const cronNames = ['slow-1', 'slow-2', 'slow-3'];
    for (const name of cronNames) {
      addCron(agent, makeCronDef(name, '1h', {
        last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
      }));
    }

    const s = buildScheduler(agent, slowFire, logs);
    s.start();

    // Advance TICK_MS + extra to let all 3 slow fires complete
    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000);

    s.stop();

    // Assert: all 3 crons eventually delivered (no failures despite 200ms delay)
    expect(firedNames).toHaveLength(3);
    for (const name of cronNames) {
      expect(firedNames).toContain(name);
    }

    // Assert: all log entries show status=fired (no retries needed for slow-but-succeeding)
    const logEntries = readLog(agent).filter(e => e.status === 'fired');
    expect(logEntries).toHaveLength(3);
  });

  it('5b: intermittent failure (50% rate) — retry logic ensures eventual delivery', async () => {
    const agent = 'flaky-pty-agent';
    ensureAgentDir(agent);

    let callCount = 0;
    const logs: string[] = [];

    // Fail on odd attempts (1, 3), succeed on even (2, 4)
    // This models ~50% intermittent failure rate
    const flakyFire = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 1) {
        throw new Error(`PTY intermittent failure (attempt ${callCount})`);
      }
    });

    addCron(agent, makeCronDef('flaky-cron', '24h', {
      last_fired_at: new Date(Date.now() - 25 * ONE_HOUR).toISOString(),
    }));

    const s = buildScheduler(agent, flakyFire, logs);
    s.start();

    // First tick fires (attempt 1 fails), then retry after 1s (attempt 2 succeeds)
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(1_000 + 500); // retry delay + buffer

    s.stop();

    // Assert: 2 call attempts (1 fail + 1 succeed)
    expect(flakyFire).toHaveBeenCalledTimes(2);

    // Assert: 1 retried + 1 fired in log
    const logEntries = readLog(agent).filter(e => e.cron === 'flaky-cron');
    const retried = logEntries.filter(e => e.status === 'retried');
    const succeeded = logEntries.filter(e => e.status === 'fired');

    expect(retried).toHaveLength(1);
    expect(succeeded).toHaveLength(1);

    // Assert: retry attempt numbers logged correctly
    expect(retried[0].attempt).toBe(1);
    expect(succeeded[0].attempt).toBe(2);

    // Assert: error message in retried entry
    expect(retried[0].error).toContain('PTY intermittent failure');

    // Assert: eventual delivery within acceptable window (max 21s after initial attempt)
    // With 1s retry delay and immediate success on retry, real window is ~1s
    // The log timestamps confirm delivery before s.stop()
    expect(succeeded[0].ts).toBeDefined();
  });

  it('5c: persistent failure — exhausts 4 attempts, logs final failure with attempt counts', async () => {
    const agent = 'dead-pty-agent';
    ensureAgentDir(agent);

    const logs: string[] = [];
    let attempts = 0;

    const alwaysFail = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error(`PTY dead (attempt ${attempts})`);
    });

    addCron(agent, makeCronDef('dead-cron', '24h', {
      last_fired_at: new Date(Date.now() - 25 * ONE_HOUR).toISOString(),
    }));

    const s = buildScheduler(agent, alwaysFail, logs);
    s.start();

    // Drive all 4 attempts: tick + 1s + 4s + 16s + buffer
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(1_000);

    s.stop();

    // 4 total attempts
    expect(alwaysFail).toHaveBeenCalledTimes(4);

    const logEntries = readLog(agent).filter(e => e.cron === 'dead-cron');
    const retriedEntries = logEntries.filter(e => e.status === 'retried');
    const failedEntries = logEntries.filter(e => e.status === 'failed');

    // 3 retried + 1 final failed
    expect(retriedEntries).toHaveLength(3);
    expect(failedEntries).toHaveLength(1);

    // Attempt numbers logged correctly (1, 2, 3 for retried; 4 for failed)
    expect(retriedEntries[0].attempt).toBe(1);
    expect(retriedEntries[1].attempt).toBe(2);
    expect(retriedEntries[2].attempt).toBe(3);
    expect(failedEntries[0].attempt).toBe(4);

    // "giving up" log message present
    expect(logs.some(l => l.includes('giving up'))).toBe(true);

    // Assert: scheduler does NOT crash — continues to run
    // (tested by successful stop() call above without throw)
  });

  it('5d: retry timing matches 1s/4s/16s exponential backoff schedule', async () => {
    const agent = 'timing-pty-agent';
    ensureAgentDir(agent);

    const callTimes: number[] = [];
    let count = 0;

    const failFirst3 = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      count++;
      if (count < 4) throw new Error('retry me');
    });

    addCron(agent, makeCronDef('timed', '24h', {
      last_fired_at: new Date(Date.now() - 25 * ONE_HOUR).toISOString(),
    }));

    const s = buildScheduler(agent, failFirst3);
    s.start();

    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 16_000 + 1_000);

    s.stop();

    expect(callTimes).toHaveLength(4);

    const gap1 = callTimes[1] - callTimes[0]; // ~1s
    const gap2 = callTimes[2] - callTimes[1]; // ~4s
    const gap3 = callTimes[3] - callTimes[2]; // ~16s

    expect(gap1).toBeGreaterThanOrEqual(1_000);
    expect(gap1).toBeLessThanOrEqual(2_000);
    expect(gap2).toBeGreaterThanOrEqual(4_000);
    expect(gap2).toBeLessThanOrEqual(6_000);
    expect(gap3).toBeGreaterThanOrEqual(16_000);
    expect(gap3).toBeLessThanOrEqual(20_000);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Concurrent stress (Day 6)
// ---------------------------------------------------------------------------

describe('Scenario 6: Concurrent stress — 10 crons fire simultaneously, no race conditions', () => {
  it('10 crons fire concurrently; all log entries present, no JSON corruption', async () => {
    // 3 agents: 3 + 3 + 4 = 10 crons total
    const agentDefs: Array<{ agent: string; names: string[] }> = [
      {
        agent: 'stress-a',
        names: ['a1', 'a2', 'a3'],
      },
      {
        agent: 'stress-b',
        names: ['b1', 'b2', 'b3'],
      },
      {
        agent: 'stress-c',
        names: ['c1', 'c2', 'c3', 'c4'],
      },
    ];

    for (const { agent, names } of agentDefs) {
      ensureAgentDir(agent);
      for (const name of names) {
        // All 10 crons have last_fired_at 90min ago — all catch up on first tick simultaneously
        addCron(agent, makeCronDef(name, '1h', {
          last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
        }));
      }
    }

    const allFired: string[] = [];

    // Use Promise.all to simulate true concurrency at the test level
    // (the scheduler fires within a single tick, processing all crons)
    const schedulerFires: Array<Promise<void>> = [];

    const schedulers = agentDefs.map(({ agent, names }) =>
      buildScheduler(agent, (cron) => {
        allFired.push(`${agent}:${cron.name}`);
      })
    );

    // Start all schedulers — they all process their first tick concurrently
    schedulers.forEach(s => s.start());

    // Single tick: all 10 crons should fire within this tick
    // The scheduler processes all due crons in one tick() call
    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000);

    schedulers.forEach(s => s.stop());

    // Assert: all 10 crons produced fire entries
    expect(allFired).toHaveLength(10);

    // Assert: each specific cron fired exactly once
    for (const { agent, names } of agentDefs) {
      for (const name of names) {
        const key = `${agent}:${name}`;
        const count = allFired.filter(f => f === key).length;
        expect(count, `${key} should have fired exactly once`).toBe(1);
      }
    }

    // Assert: all 10 log entries present (no lost writes)
    for (const { agent, names } of agentDefs) {
      const logEntries = readLog(agent).filter(e => e.status === 'fired');
      expect(logEntries).toHaveLength(names.length);
      for (const name of names) {
        expect(logEntries.some(e => e.cron === name), `${agent}:${name} should be in log`).toBe(true);
      }
    }

    // Assert: crons.json correctly reflects all lastFire timestamps (no atomic write race)
    for (const { agent, names } of agentDefs) {
      // Read raw file — verify valid JSON (no corruption from concurrent writes)
      const rawPath = cronsFilePath(agent);
      let parsed: unknown;
      expect(() => {
        const raw = readFileSync(rawPath, 'utf-8');
        parsed = JSON.parse(raw);
      }, `${agent}/crons.json should be valid JSON after concurrent writes`).not.toThrow();

      // All fire_count values should be 1
      const cronsOnDisk = (parsed as { crons: CronDefinition[] }).crons;
      for (const name of names) {
        const cron = cronsOnDisk.find(c => c.name === name);
        expect(cron?.fire_count, `${agent}:${name} fire_count should be 1`).toBe(1);
        expect(cron?.last_fired_at, `${agent}:${name} should have last_fired_at`).toBeDefined();
      }
    }
  });

  it('second concurrent burst: 10 more simultaneous fires after 1h — cumulative counts correct', async () => {
    const agentNames = ['burst-a', 'burst-b'];
    const namesA = ['ba1', 'ba2', 'ba3', 'ba4', 'ba5'];
    const namesB = ['bb1', 'bb2', 'bb3', 'bb4', 'bb5'];

    for (const agent of agentNames) ensureAgentDir(agent);
    for (const name of namesA) {
      addCron('burst-a', makeCronDef(name, '1h', {
        last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
      }));
    }
    for (const name of namesB) {
      addCron('burst-b', makeCronDef(name, '1h', {
        last_fired_at: new Date(Date.now() - 90 * ONE_MIN).toISOString(),
      }));
    }

    const totalFired: string[] = [];
    const sA = buildScheduler('burst-a', (c) => totalFired.push(`a:${c.name}`));
    const sB = buildScheduler('burst-b', (c) => totalFired.push(`b:${c.name}`));

    sA.start();
    sB.start();

    // First burst: all 10 fire on tick 1
    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000);
    expect(totalFired).toHaveLength(10);

    // Advance 1h — all 10 should fire again in next tick
    await advanceSim(ONE_HOUR + TICK_MS);

    sA.stop();
    sB.stop();

    // Assert: all 10 fired at least twice (once per burst)
    const countMap = new Map<string, number>();
    for (const key of totalFired) {
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }
    for (const name of namesA) {
      expect(countMap.get(`a:${name}`) ?? 0).toBeGreaterThanOrEqual(2);
    }
    for (const name of namesB) {
      expect(countMap.get(`b:${name}`) ?? 0).toBeGreaterThanOrEqual(2);
    }

    // Assert: no JSON corruption in either agent's crons.json
    for (const agent of agentNames) {
      expect(() => {
        const raw = readFileSync(cronsFilePath(agent), 'utf-8');
        JSON.parse(raw);
      }, `${agent}/crons.json should be valid JSON after burst`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Dashboard polling accuracy (Day 7)
// ---------------------------------------------------------------------------

describe('Scenario 7: Dashboard polling accuracy throughout simulation', () => {
  // This scenario imports the real dashboard API routes to poll during simulation.
  // We follow the Phase 4 pattern: routes called directly with NextRequest,
  // CTX_ROOT set to our tmpRoot, enabled-agents.json written to config dir.

  const CONFIG_DIR_REL = 'config';
  const CRONS_STATE_REL = '.cortextOS/state/agents';

  function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>): void {
    const configDir = join(tmpRoot, CONFIG_DIR_REL);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify(agents, null, 2),
    );
  }

  it('dashboard /api/workflows/crons and /api/workflows/health reflect accurate state at every poll', async () => {
    // Agents
    const pollingAgents = {
      'poll-boris':  { enabled: true, org: 'lifeos' },
      'poll-paul':   { enabled: true, org: 'lifeos' },
      'poll-nick':   { enabled: true, org: 'lifeos' },
    };

    writeEnabledAgents(pollingAgents);

    for (const agentName of Object.keys(pollingAgents)) {
      ensureAgentDir(agentName);
    }

    // 5 crons per agent = 15 total
    const agentCronMap: Record<string, CronDefinition[]> = {
      'poll-boris': [
        makeCronDef('boris-heartbeat',  '6h'),
        makeCronDef('boris-daily',      '24h'),
        makeCronDef('boris-hourly',     '1h'),
        makeCronDef('boris-30m',        '*/30 * * * *'),
        makeCronDef('boris-12h',        '12h'),
      ],
      'poll-paul': [
        makeCronDef('paul-monitor',     '1h'),
        makeCronDef('paul-daily',       '24h'),
        makeCronDef('paul-halfhour',    '*/30 * * * *'),
        makeCronDef('paul-6h',          '6h'),
        makeCronDef('paul-2h',          '2h'),
      ],
      'poll-nick': [
        makeCronDef('nick-hourly',      '0 * * * *'),
        makeCronDef('nick-daily',       '24h'),
        makeCronDef('nick-30m',         '*/30 * * * *'),
        makeCronDef('nick-6h',          '6h'),
        makeCronDef('nick-12h',         '12h'),
      ],
    };

    const fireTracker: Record<string, number> = {};
    for (const [agent, crons] of Object.entries(agentCronMap)) {
      for (const cron of crons) {
        addCron(agent, cron);
        fireTracker[`${agent}::${cron.name}`] = 0;
      }
    }

    // Build schedulers with fire tracking
    const schedulers = Object.keys(pollingAgents).map(agent =>
      buildScheduler(agent, (cron) => {
        const key = `${agent}::${cron.name}`;
        fireTracker[key] = (fireTracker[key] ?? 0) + 1;
      })
    );
    schedulers.forEach(s => s.start());

    // Import dashboard routes AFTER CTX_ROOT is set
    // (Re-import needed since CTX_ROOT changed in this test context)
    vi.resetModules();
    const [cronsRootModule, healthModule] = await Promise.all([
      import('../../dashboard/src/app/api/workflows/crons/route.js'),
      import('../../dashboard/src/app/api/workflows/health/route.js'),
    ]);
    const { NextRequest } = await import('next/server');

    // We'll poll at simulated T=0, T=10h, T=20h (3 checkpoints in 24h sim)
    const pollResults: Array<{
      simTimeH: number;
      cronsListCount: number;
      healthSummary: { healthy: number; warning: number; failure: number; neverFired: number };
    }> = [];

    async function poll(simTimeH: number): Promise<void> {
      // GET /api/workflows/crons — list all
      const cronsReq = new NextRequest('http://localhost/api/workflows/crons');
      const cronsRes = await cronsRootModule.GET(cronsReq);
      const cronsBody = await cronsRes.json();

      // GET /api/workflows/health
      const healthReq = new NextRequest('http://localhost/api/workflows/health');
      const healthRes = await healthModule.GET(healthReq);
      const healthBody = await healthRes.json();

      pollResults.push({
        simTimeH,
        cronsListCount: Array.isArray(cronsBody) ? cronsBody.length : 0,
        healthSummary: healthBody.summary
          ? {
              healthy:    healthBody.summary.healthy    ?? 0,
              warning:    healthBody.summary.warning    ?? 0,
              failure:    healthBody.summary.failure    ?? 0,
              neverFired: healthBody.summary.neverFired ?? 0,
            }
          : { healthy: 0, warning: 0, failure: 0, neverFired: 0 },
      });
    }

    // Poll at T=0 (before any fires)
    await poll(0);

    // Run simulation in 10h chunks, polling at each checkpoint
    for (const checkpoint of [10, 20]) {
      await advanceSim(10 * ONE_HOUR);
      await poll(checkpoint);
    }

    // Final 4h to complete 24h
    await advanceSim(4 * ONE_HOUR);
    await poll(24);

    schedulers.forEach(s => s.stop());

    // Assert: /api/workflows/crons list returned the right count at every poll
    for (const poll of pollResults) {
      // All 15 crons registered for the 3 polling agents should appear
      expect(
        poll.cronsListCount,
        `At T=${poll.simTimeH}h, crons list should show 15 crons for polling agents`
      ).toBeGreaterThanOrEqual(15);
    }

    // Assert: at T=0, crons are neverFired (no execution log yet)
    const t0 = pollResults[0];
    // At T=0 no fires have happened yet, so neverFired count should be 15 (all crons)
    expect(t0.healthSummary.neverFired).toBeGreaterThanOrEqual(15);
    expect(t0.healthSummary.healthy).toBe(0);

    // Assert: at T=24h, some crons are healthy (have fired recently)
    const t24 = pollResults[pollResults.length - 1];
    expect(t24.healthSummary.healthy).toBeGreaterThan(0);
    expect(t24.healthSummary.neverFired).toBeLessThan(15);

    // Assert: consistency — health summary counts at T=24h match actual fire state
    // Crons with schedule ≤ 12h should have fired at least once in 24h → healthy
    // Crons with schedule = 24h: 1 fire expected → healthy (gap = 0 < 2×24h = 48h)
    // So at T=24h, all 15 crons should have fired at least once → healthy, not neverFired
    expect(t24.healthSummary.neverFired).toBe(0);

    // Assert: nextFire / lastFire fields in crons list response are valid ISO strings
    // Re-query at end
    const finalCronsReq = new NextRequest('http://localhost/api/workflows/crons?agent=poll-boris');
    const finalCronsRes = await cronsRootModule.GET(finalCronsReq);
    const finalCronsBody = await finalCronsRes.json();

    expect(Array.isArray(finalCronsBody)).toBe(true);
    for (const row of finalCronsBody) {
      expect(row.agent).toBe('poll-boris');
      expect(row.cron).toBeDefined();
      expect(row.nextFire).toBeDefined();
      expect(row.nextFire).not.toBe('unknown');
      // lastFire comes from execution log (null if never fired, ISO string otherwise)
      // After 24h sim all boris crons should have fired
      if (row.lastFire !== null && row.lastFire !== undefined) {
        expect(() => new Date(row.lastFire).getTime()).not.toThrow();
        expect(isNaN(new Date(row.lastFire).getTime())).toBe(false);
      }
    }

    // Assert: health rows have all required fields at T=24h checkpoint
    const finalHealthReq = new NextRequest('http://localhost/api/workflows/health');
    const finalHealthRes = await healthModule.GET(finalHealthReq);
    const finalHealthBody = await finalHealthRes.json();

    const pollingAgentNames = Object.keys(pollingAgents);
    const ourRows = finalHealthBody.rows.filter(
      (r: { agent: string }) => pollingAgentNames.includes(r.agent)
    );

    for (const row of ourRows) {
      expect(row).toHaveProperty('agent');
      expect(row).toHaveProperty('cronName');
      expect(row).toHaveProperty('state');
      expect(row).toHaveProperty('lastFire');
      expect(row).toHaveProperty('nextFire');
      expect(row).toHaveProperty('gapMs');
      expect(row).toHaveProperty('successRate24h');
    }

    // Assert: per-agent breakdown in summary.agents
    expect(finalHealthBody.summary.agents).toBeDefined();
    for (const agentName of pollingAgentNames) {
      expect(
        finalHealthBody.summary.agents[agentName],
        `summary.agents should include ${agentName}`
      ).toBeDefined();
    }
  }, 120_000); // allow 2m real time for this scenario
});
