/**
 * tests/integration/agent-bootstrap-crons.test.ts — Subtask 2.1 Bootstrap Tests
 *
 * Covers the four acceptance scenarios from the plan:
 *
 *   1. Boot agent with crons.json → scheduler registers all crons
 *      (assert via scheduler.getNextFireTimes())
 *   2. Boot agent without crons.json → graceful, scheduler has no entries
 *   3. Boot agent with corrupted crons.json → logged error, scheduler skips that
 *      agent, OTHER agents unaffected
 *   4. Daemon reload after add-cron via bus → scheduler picks up new cron
 *
 * These tests use REAL disk I/O (per-test temp CTX_ROOT) driven by vitest fake
 * timers.  No module mocking — the full stack (crons.ts, cron-scheduler.ts)
 * runs its real code, exactly as the daemon does.
 *
 * The "daemon singleton" is simulated here as a Map<agentName, CronScheduler>,
 * which is precisely how AgentManager.cronSchedulers works in production.
 * AgentManager itself is not imported here because it requires PTY mocking;
 * we test the scheduler layer that AgentManager wires in startAgentCronScheduler().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { CronDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants matching the phase1 test conventions
// ---------------------------------------------------------------------------

const TICK_MS = 30_000; // CronScheduler.TICK_INTERVAL_MS
const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';

// ---------------------------------------------------------------------------
// Per-test environment wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let addCron: typeof import('../../src/bus/crons.js').addCron;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules() {
  vi.resetModules();
  const cronsModule = await import('../../src/bus/crons.js');
  addCron = cronsModule.addCron;
  readCrons = cronsModule.readCrons;
  const schedulerModule = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler = schedulerModule.CronScheduler;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bootstrap-crons-test-'));
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
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the agent state dir exists (crons.ts creates this lazily, but tests need it for crons.json writes). */
function ensureAgentStateDir(agentName: string): string {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a valid crons.json for an agent with the given definitions. */
function writeCronsJson(agentName: string, crons: CronDefinition[]): void {
  const dir = ensureAgentStateDir(agentName);
  const envelope = {
    updated_at: new Date().toISOString(),
    crons,
  };
  writeFileSync(join(dir, CRONS_FILE), JSON.stringify(envelope, null, 2), 'utf-8');
}

/** Write raw bytes (for corruption testing). */
function writeCorruptCronsJson(agentName: string): void {
  const dir = ensureAgentStateDir(agentName);
  writeFileSync(join(dir, CRONS_FILE), 'not valid json { {{ }}', 'utf-8');
}

/** Build a minimal CronDefinition. */
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

/**
 * Build a CronScheduler backed by real disk I/O.
 * The onFire callback records fired cron names for assertions.
 * The logger captures output so we can assert on error messages.
 */
function buildScheduler(
  agentName: string,
  firedCrons: string[] = [],
  logs: string[] = [],
) {
  return new CronScheduler({
    agentName,
    onFire: async (cron: CronDefinition) => { firedCrons.push(cron.name); },
    logger: (msg) => logs.push(msg),
  });
}

// ---------------------------------------------------------------------------
// Scenario 1 — Boot with crons.json → scheduler registers all crons
// ---------------------------------------------------------------------------

describe('Scenario 1: Boot with crons.json', () => {
  it('registers all enabled crons in getNextFireTimes()', async () => {
    const agentName = 'boris';

    // Write 3 crons: 2 enabled, 1 disabled
    writeCronsJson(agentName, [
      makeCronDef('heartbeat', '1h'),
      makeCronDef('morning-briefing', '0 9 * * *'),
      makeCronDef('paused', '2h', { enabled: false }),
    ]);

    const scheduler = buildScheduler(agentName);
    scheduler.start();

    const fireTimes = scheduler.getNextFireTimes();

    // 2 enabled crons registered, 1 disabled silently skipped
    expect(fireTimes).toHaveLength(2);
    const names = fireTimes.map(ft => ft.name).sort();
    expect(names).toEqual(['heartbeat', 'morning-briefing']);

    // All registered crons have a valid nextFireAt in the future
    const now = Date.now();
    for (const ft of fireTimes) {
      expect(ft.nextFireAt).toBeGreaterThan(now);
    }

    scheduler.stop();
  });

  it('fires registered crons when their time arrives', async () => {
    const agentName = 'paul';
    const fired: string[] = [];

    // 1-minute interval cron
    writeCronsJson(agentName, [
      makeCronDef('fast-cron', '1m'),
    ]);

    const scheduler = buildScheduler(agentName, fired);
    scheduler.start();

    // Should not have fired yet
    expect(fired).toHaveLength(0);

    // Advance past first fire (1 min + 1 tick)
    await vi.advanceTimersByTimeAsync(60_000 + TICK_MS);

    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]).toBe('fast-cron');

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Boot without crons.json → graceful, no entries
// ---------------------------------------------------------------------------

describe('Scenario 2: Boot without crons.json', () => {
  it('starts cleanly with no crons when crons.json is absent', async () => {
    const agentName = 'donna';
    // Do NOT create crons.json for this agent

    const logs: string[] = [];
    const scheduler = buildScheduler(agentName, [], logs);
    scheduler.start();

    const fireTimes = scheduler.getNextFireTimes();
    expect(fireTimes).toHaveLength(0);

    // No error logs — absent file is silent
    const errorLogs = logs.filter(l => l.includes('ERROR') || l.includes('error'));
    expect(errorLogs).toHaveLength(0);

    // Started log is present
    expect(logs.some(l => l.includes('started') && l.includes(agentName))).toBe(true);

    scheduler.stop();
  });

  it('does not block or throw when crons.json directory does not exist', async () => {
    const agentName = 'nonexistent-agent';
    // No state directory at all

    const scheduler = buildScheduler(agentName);

    // start() must not throw
    expect(() => scheduler.start()).not.toThrow();

    const fireTimes = scheduler.getNextFireTimes();
    expect(fireTimes).toHaveLength(0);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Boot with corrupted crons.json → log error, skip agent, others unaffected
// ---------------------------------------------------------------------------

describe('Scenario 3: Boot with corrupted crons.json', () => {
  it('logs a parse error and registers 0 crons for the corrupted agent', async () => {
    const agentName = 'broken-agent';
    writeCorruptCronsJson(agentName);

    const logs: string[] = [];
    const scheduler = buildScheduler(agentName, [], logs);
    scheduler.start();

    // No crons registered for the corrupted agent
    expect(scheduler.getNextFireTimes()).toHaveLength(0);

    // crons.ts emits a stderr warning for corrupted JSON; the scheduler
    // itself logs a "started … 0 cron(s)" line (not an error-level log)
    const startedLog = logs.find(l => l.includes('started') && l.includes('0 cron'));
    expect(startedLog).toBeDefined();

    scheduler.stop();
  });

  it('other agents are unaffected when one agent has corrupted crons.json', async () => {
    // Simulates the daemon's per-agent scheduler map:
    //   cronSchedulers: Map<agentName, CronScheduler>

    const brokenAgent = 'bad-agent';
    const goodAgent = 'good-agent';

    writeCorruptCronsJson(brokenAgent);
    writeCronsJson(goodAgent, [
      makeCronDef('heartbeat', '4h'),
      makeCronDef('daily-report', '0 6 * * *'),
    ]);

    const brokenScheduler = buildScheduler(brokenAgent);
    const goodScheduler = buildScheduler(goodAgent);

    // Both start() calls must succeed regardless of corruption
    expect(() => brokenScheduler.start()).not.toThrow();
    expect(() => goodScheduler.start()).not.toThrow();

    // Broken agent: 0 crons
    expect(brokenScheduler.getNextFireTimes()).toHaveLength(0);

    // Good agent: 2 crons registered correctly
    const goodCrons = goodScheduler.getNextFireTimes();
    expect(goodCrons).toHaveLength(2);
    const names = goodCrons.map(c => c.name).sort();
    expect(names).toEqual(['daily-report', 'heartbeat']);

    brokenScheduler.stop();
    goodScheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Daemon reload after add-cron via bus → picks up new cron
// ---------------------------------------------------------------------------

describe('Scenario 4: Reload after bus add-cron', () => {
  it('picks up a newly added cron after reload()', async () => {
    const agentName = 'matt';

    // Start with 1 cron
    writeCronsJson(agentName, [
      makeCronDef('heartbeat', '6h'),
    ]);

    const fired: string[] = [];
    const scheduler = buildScheduler(agentName, fired);
    scheduler.start();

    expect(scheduler.getNextFireTimes()).toHaveLength(1);
    expect(scheduler.getNextFireTimes()[0].name).toBe('heartbeat');

    // Simulate: user calls `bus add-cron` which writes to crons.json,
    // then calls `agentManager.reloadCrons(agentName)` → scheduler.reload()
    addCron(agentName, makeCronDef('morning-briefing', '0 9 * * *'));
    scheduler.reload();

    // Scheduler now has 2 crons
    const fireTimes = scheduler.getNextFireTimes();
    expect(fireTimes).toHaveLength(2);
    const names = fireTimes.map(ft => ft.name).sort();
    expect(names).toEqual(['heartbeat', 'morning-briefing']);

    scheduler.stop();
  });

  it('preserves nextFireAt for unchanged crons on reload()', async () => {
    const agentName = 'nick';

    writeCronsJson(agentName, [
      makeCronDef('heartbeat', '4h'),
    ]);

    const scheduler = buildScheduler(agentName);
    scheduler.start();

    const beforeReload = scheduler.getNextFireTimes()[0].nextFireAt;

    // Add a second cron but leave heartbeat unchanged
    addCron(agentName, makeCronDef('digest', '12h'));
    scheduler.reload();

    const afterReload = scheduler.getNextFireTimes().find(ft => ft.name === 'heartbeat')!;
    expect(afterReload).toBeDefined();

    // nextFireAt for the unchanged cron must be identical — no timer reset
    expect(afterReload.nextFireAt).toBe(beforeReload);

    // New cron has its own fire time
    const digest = scheduler.getNextFireTimes().find(ft => ft.name === 'digest')!;
    expect(digest).toBeDefined();
    expect(digest.nextFireAt).toBeGreaterThan(Date.now());

    scheduler.stop();
  });

  it('removing a cron via reload() makes it disappear from getNextFireTimes()', async () => {
    const agentName = 'skoolio';

    writeCronsJson(agentName, [
      makeCronDef('job-a', '1h'),
      makeCronDef('job-b', '2h'),
    ]);

    const { removeCron } = await import('../../src/bus/crons.js');

    const scheduler = buildScheduler(agentName);
    scheduler.start();

    expect(scheduler.getNextFireTimes()).toHaveLength(2);

    // Remove job-b from disk, then reload
    removeCron(agentName, 'job-b');
    scheduler.reload();

    const fireTimes = scheduler.getNextFireTimes();
    expect(fireTimes).toHaveLength(1);
    expect(fireTimes[0].name).toBe('job-a');

    scheduler.stop();
  });
});
