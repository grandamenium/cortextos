/**
 * tests/integration/multi-agent-crons.test.ts — Subtask 2.5 Multi-Agent Integration Tests
 *
 * End-to-end validation of the migration + scheduling pipeline across 5 agents
 * (18 crons total) covering:
 *
 *   Scenario 1: Migration + boot all agents
 *   Scenario 2: Schedulers register all crons (getNextFireTimes counts)
 *   Scenario 3: 72-hour simulation — correct fire counts, no cross-agent leakage
 *   Scenario 4: Cross-agent message passing still works (bus sendMessage)
 *   Scenario 5: Idempotent re-migration (no duplicate crons, marker mtime unchanged)
 *   Scenario 6: Per-agent log files written correctly (no cross-contamination)
 *   Scenario 7: Concurrent scheduler ticks don't corrupt crons.json
 *
 * TIMER STRATEGY
 * --------------
 * vi.useFakeTimers() intercepts setInterval, setTimeout, and Date.now().
 * We advance in 60_000 ms steps (1 minute) so cron-expression boundaries are
 * always caught.  72h = 4 320 steps — fast because each step is a sync timer
 * queue drain with no real I/O blocking.
 *
 * CRON-EXPR + WEEKDAY TOLERANCE
 * ------------------------------
 * Schedules like "0 9 * * 1-5" (pipeline-check, weekdays 09:00 UTC) depend on
 * the real-clock day when vi.useFakeTimers() is initialised (fake timers start
 * at real Date.now()).  We use a ±1 fire tolerance for all cron-expression
 * schedules and a ±1 tolerance for interval shorthands that sit near a boundary.
 *
 * ISOLATION
 * ---------
 * Each `describe` block shares a single beforeEach/afterEach that creates a
 * fresh pair of temp directories (tmpCtxRoot, tmpFrameworkRoot) and reloads
 * all modules so there is zero state bleed across scenarios.  Within each
 * scenario the 5 agents write to completely separate per-agent sub-directories
 * under the shared tmpCtxRoot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { CronDefinition, CronExecutionLogEntry, BusPaths } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_MS = 30_000;  // CronScheduler.TICK_INTERVAL_MS
const ONE_MIN = 60_000;
const ONE_HOUR = 3_600_000;
const SIM_72H = 72 * ONE_HOUR;

const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

// ---------------------------------------------------------------------------
// 5 Agent Fixture Definitions
//
// Fully synthetic — never reads real config.json from the repository.
//
// Total: 18 crons across 5 agents.
//
// Expected fires in 72h (computed analytically, start = test boot epoch):
//   boris:    heartbeat(6h)=12, pr-monitor(6h)=12, exp-pr(24h)=3, exp-task(24h)=3   → 30
//   paul:     heartbeat(4h)=18, morning(0 13)=3, evening(0 1)=3, worker(1h)=72,
//             human-sweep(2h)=36, draft-approval(30 17)=3                             → 135
//   sentinel: health(15m)=288, gap-detect(1h)=72, upstream(12h)=6                    → 366
//   donna:    inbox(0 12)=3, draft-tracker(4h)=18                                    → 21
//   nick:     deliverables(1h)=72, heartbeat(6h)=12, pipeline(0 9 1-5)=2±1          → 86±1
//
// Grand total ≈ 638 (cron-expr fires may vary ±1 per cron depending on sim start).
// ---------------------------------------------------------------------------

interface AgentFixture {
  name: string;
  crons: Array<{
    name: string;
    type?: 'recurring' | 'once' | 'disabled';
    interval?: string;
    cron?: string;
    prompt: string;
  }>;
}

const AGENT_FIXTURES: AgentFixture[] = [
  {
    name: 'boris',
    crons: [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md and run heartbeat workflow.' },
      { name: 'pr-monitor', type: 'recurring', interval: '6h', prompt: 'Scan open PRs for cortextos.' },
      { name: 'experiment-pr-cycle-time', type: 'recurring', interval: '24h', prompt: 'Record pr-cycle-time metric.' },
      { name: 'experiment-task-completion-rate', type: 'recurring', interval: '24h', prompt: 'Record task-completion-rate metric.' },
    ],
  },
  {
    name: 'paul',
    crons: [
      { name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'Run paul heartbeat.' },
      { name: 'morning-review', cron: '0 13 * * *', prompt: 'Deliver morning briefing to James.' },
      { name: 'evening-review', cron: '0 1 * * *', prompt: 'Deliver evening review to James.' },
      { name: 'worker-monitor', type: 'recurring', interval: '1h', prompt: 'Check all active M2C1 workers.' },
      { name: 'human-task-sweep', type: 'recurring', interval: '2h', prompt: 'Check HUMAN tasks and nudge James.' },
      { name: 'draft-approval-check', cron: '30 17 * * *', prompt: 'Surface pending draft approvals.' },
    ],
  },
  {
    name: 'sentinel',
    crons: [
      { name: 'system-health-check', type: 'recurring', interval: '15m', prompt: 'Check all agent heartbeats.' },
      { name: 'cron-gap-detector', type: 'recurring', interval: '1h', prompt: 'Detect cron execution gaps.' },
      { name: 'upstream-sync', type: 'recurring', interval: '12h', prompt: 'Sync upstream cortextos changes.' },
    ],
  },
  {
    name: 'donna',
    crons: [
      { name: 'inbox-sweep', cron: '0 12 * * *', prompt: 'Full Gmail inbox sweep.' },
      { name: 'draft-tracker', type: 'recurring', interval: '4h', prompt: 'Check draft approval statuses.' },
    ],
  },
  {
    name: 'nick',
    crons: [
      { name: 'deliverables-watch', type: 'recurring', interval: '1h', prompt: 'Check for deliverables-needed from orchestrator.' },
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run nick heartbeat.' },
      { name: 'pipeline-check', cron: '0 9 * * 1-5', prompt: 'Weekday 09:00 UTC pipeline check.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Interval shorthand → expected fires in 72h (exact, no rounding edge)
// ---------------------------------------------------------------------------
const INTERVAL_EXPECTED_FIRES: Record<string, number> = {
  '15m':  288, // 72h / 0.25h
  '1h':    72,
  '2h':    36,
  '4h':    18,
  '6h':    12,
  '12h':    6,
  '24h':    3,
};

// Per-cron expected fire ranges: [min, max] inclusive.
// Cron-expression schedules get ±1 tolerance due to sim-start day dependency.
const CRON_EXPECTED_FIRES: Record<string, { min: number; max: number }> = {
  // boris
  'boris/heartbeat':                             { min: 11, max: 13 },
  'boris/pr-monitor':                            { min: 11, max: 13 },
  'boris/experiment-pr-cycle-time':              { min: 2,  max: 4  },
  'boris/experiment-task-completion-rate':       { min: 2,  max: 4  },
  // paul
  'paul/heartbeat':                              { min: 17, max: 19 },
  'paul/morning-review':                         { min: 2,  max: 4  },
  'paul/evening-review':                         { min: 2,  max: 4  },
  'paul/worker-monitor':                         { min: 71, max: 73 },
  'paul/human-task-sweep':                       { min: 35, max: 37 },
  'paul/draft-approval-check':                   { min: 2,  max: 4  },
  // sentinel
  'sentinel/system-health-check':                { min: 287, max: 289 },
  'sentinel/cron-gap-detector':                  { min: 71, max: 73  },
  'sentinel/upstream-sync':                      { min: 5,  max: 7   },
  // donna
  'donna/inbox-sweep':                           { min: 2,  max: 4   },
  'donna/draft-tracker':                         { min: 17, max: 19  },
  // nick
  'nick/deliverables-watch':                     { min: 71, max: 73  },
  'nick/heartbeat':                              { min: 11, max: 13  },
  'nick/pipeline-check':                         { min: 0,  max: 11  }, // weekday 09:00 — 0-10 in 72h
};

// ---------------------------------------------------------------------------
// Per-test environment wiring
// ---------------------------------------------------------------------------

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test)
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let migrateAllAgents: typeof import('../../src/daemon/cron-migration.js').migrateAllAgents;
let isMigrated: typeof import('../../src/daemon/cron-migration.js').isMigrated;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let addCron: typeof import('../../src/bus/crons.js').addCron;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;
let sendMessage: typeof import('../../src/bus/message.js').sendMessage;

async function reloadModules(): Promise<void> {
  vi.resetModules();
  const migMod = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migMod.migrateCronsForAgent;
  migrateAllAgents     = migMod.migrateAllAgents;
  isMigrated           = migMod.isMigrated;
  const cronsMod = await import('../../src/bus/crons.js');
  readCrons  = cronsMod.readCrons;
  addCron    = cronsMod.addCron;
  const schedulerMod = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler = schedulerMod.CronScheduler;
  const messageMod = await import('../../src/bus/message.js');
  sendMessage = messageMod.sendMessage;
}

beforeEach(async () => {
  tmpCtxRoot      = mkdtempSync(join(tmpdir(), 'multi-agent-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'multi-agent-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
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
  try { rmSync(tmpCtxRoot,      { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a synthetic config.json for an agent into the temp framework root.
 */
function writeAgentConfig(fixture: AgentFixture): string {
  const agentDir = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', fixture.name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      agent_name: fixture.name,
      enabled: true,
      crons: fixture.crons,
    }),
    'utf-8',
  );
  return join(agentDir, 'config.json');
}

/**
 * Create the agent state directory under tmpCtxRoot.
 */
function ensureAgentStateDir(agentName: string): string {
  const dir = join(tmpCtxRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read all JSONL entries from an agent's cron-execution.log.
 */
function readLog(agentName: string): CronExecutionLogEntry[] {
  const logPath = join(tmpCtxRoot, '.cortextOS', 'state', 'agents', agentName, 'cron-execution.log');
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as CronExecutionLogEntry);
}

/**
 * Read raw crons.json envelope from disk.
 */
function rawCronsJson(agentName: string): { updated_at: string; crons: CronDefinition[] } | null {
  const path = join(tmpCtxRoot, CRONS_DIR, agentName, CRONS_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Check whether the migration marker exists for an agent.
 */
function markerExists(agentName: string): boolean {
  return existsSync(join(tmpCtxRoot, CRONS_DIR, agentName, MARKER_FILE));
}

/**
 * Advance fake timers by totalMs in stepMs increments.
 */
async function advanceSim(totalMs: number, stepMs = ONE_MIN): Promise<void> {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    const remaining = totalMs - i * stepMs;
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, remaining));
  }
}

/**
 * Build a CronScheduler for an agent that records fires into a shared event log.
 *
 * The event log entry is: { agent, cronName, ts }
 */
type FireEvent = { agent: string; cronName: string; ts: number };

function buildMultiAgentScheduler(
  agentName: string,
  eventLog: FireEvent[],
  schedulerLogs: string[] = [],
) {
  return new CronScheduler({
    agentName,
    onFire: (cron: CronDefinition) => {
      eventLog.push({ agent: agentName, cronName: cron.name, ts: Date.now() });
    },
    logger: (msg: string) => schedulerLogs.push(msg),
  });
}

/**
 * Build a minimal BusPaths object for the test's tmpCtxRoot.
 */
function buildBusPaths(agentName: string): BusPaths {
  const ctxRoot = tmpCtxRoot;
  return {
    ctxRoot,
    inbox:       join(ctxRoot, 'inbox',     agentName),
    inflight:    join(ctxRoot, 'inflight',  agentName),
    processed:   join(ctxRoot, 'processed', agentName),
    logDir:      join(ctxRoot, 'logs',      agentName),
    stateDir:    join(ctxRoot, '.cortextOS', 'state', 'agents', agentName),
    taskDir:     join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', 'lifeos', 'deliverables'),
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Migration + boot all agents
// ---------------------------------------------------------------------------

describe('Scenario 1: Migration + boot all agents', () => {
  it('migrates all 5 agents; each has correct crons.json + marker; no cross-agent crons', () => {
    // Write all 5 agent configs into tmpFrameworkRoot
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
    }

    // Run migration per-agent individually (mirrors how daemon boots each agent)
    const results = AGENT_FIXTURES.map(f => {
      const configPath = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', f.name, 'config.json');
      return migrateCronsForAgent(f.name, configPath, tmpCtxRoot, { log: () => {} });
    });

    // Every agent migrated successfully
    for (const r of results) {
      expect(r.status, `${r.agentName} should be migrated`).toBe('migrated');
      expect(r.cronsSkipped, `${r.agentName} should have no skipped crons`).toHaveLength(0);
    }

    // Verify cron counts per agent
    expect(results[0].cronsMigrated, 'boris: 4 crons').toBe(4);  // boris
    expect(results[1].cronsMigrated, 'paul: 6 crons').toBe(6);   // paul
    expect(results[2].cronsMigrated, 'sentinel: 3 crons').toBe(3); // sentinel
    expect(results[3].cronsMigrated, 'donna: 2 crons').toBe(2);  // donna
    expect(results[4].cronsMigrated, 'nick: 3 crons').toBe(3);   // nick

    // Total = 18
    const totalMigrated = results.reduce((sum, r) => sum + (r.cronsMigrated ?? 0), 0);
    expect(totalMigrated, 'total 18 crons across 5 agents').toBe(18);

    // Marker files exist for every agent
    for (const fixture of AGENT_FIXTURES) {
      expect(markerExists(fixture.name), `${fixture.name} marker exists`).toBe(true);
      expect(isMigrated(tmpCtxRoot, fixture.name), `${fixture.name} isMigrated`).toBe(true);
    }

    // No cross-agent contamination: each agent's crons.json contains ONLY that agent's cron names
    const borisKnown    = new Set(AGENT_FIXTURES[0].crons.map(c => c.name));
    const paulKnown     = new Set(AGENT_FIXTURES[1].crons.map(c => c.name));
    const sentinelKnown = new Set(AGENT_FIXTURES[2].crons.map(c => c.name));
    const donnaKnown    = new Set(AGENT_FIXTURES[3].crons.map(c => c.name));
    const nickKnown     = new Set(AGENT_FIXTURES[4].crons.map(c => c.name));

    const knownByAgent: Record<string, Set<string>> = {
      boris: borisKnown, paul: paulKnown, sentinel: sentinelKnown, donna: donnaKnown, nick: nickKnown,
    };

    for (const fixture of AGENT_FIXTURES) {
      const crons = readCrons(fixture.name);
      const known = knownByAgent[fixture.name];
      for (const c of crons) {
        expect(known.has(c.name), `${fixture.name}: cron "${c.name}" should belong to this agent`).toBe(true);
      }
    }
  });

  it('migrateAllAgents() finds all 5 agents in framework root and migrates 18 crons', () => {
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
    }

    const logs: string[] = [];
    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, { log: (msg) => logs.push(msg) });

    expect(summary.processed).toBe(5);
    expect(summary.totalCronsMigrated).toBe(18);
    expect(summary.results).toHaveLength(5);

    // All agents migrated
    for (const r of summary.results) {
      expect(r.status).toBe('migrated');
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Schedulers register all crons
// ---------------------------------------------------------------------------

describe('Scenario 2: Schedulers register all crons', () => {
  it('each scheduler has correct cron count after start(); getNextFireTimes() returns all', () => {
    // Seed crons.json directly (bypasses migration — tests scheduler layer in isolation)
    for (const fixture of AGENT_FIXTURES) {
      ensureAgentStateDir(fixture.name);
      const configPath = writeAgentConfig(fixture);
      migrateCronsForAgent(fixture.name, configPath, tmpCtxRoot, { log: () => {} });
    }

    const eventLog: FireEvent[] = [];
    const schedulers: ReturnType<typeof buildMultiAgentScheduler>[] = [];

    for (const fixture of AGENT_FIXTURES) {
      const s = buildMultiAgentScheduler(fixture.name, eventLog);
      s.start();
      schedulers.push(s);
    }

    // No time has advanced — verify next fire times are all set
    const expectedCronCounts: Record<string, number> = {
      boris: 4, paul: 6, sentinel: 3, donna: 2, nick: 3,
    };

    for (let i = 0; i < AGENT_FIXTURES.length; i++) {
      const fixture  = AGENT_FIXTURES[i];
      const s        = schedulers[i];
      const fireTimes = s.getNextFireTimes();

      expect(fireTimes.length, `${fixture.name}: ${expectedCronCounts[fixture.name]} crons registered`)
        .toBe(expectedCronCounts[fixture.name]);

      // Every nextFireAt should be a finite future number (from now or ahead)
      for (const ft of fireTimes) {
        expect(Number.isFinite(ft.nextFireAt), `${fixture.name}/${ft.name} nextFireAt is finite`).toBe(true);
        expect(ft.nextFireAt).toBeGreaterThanOrEqual(Date.now() - 1); // at or after now (catch-up fires set to now)
      }
    }

    // Total crons across all schedulers = 18
    const totalRegistered = schedulers.reduce((sum, s) => sum + s.getNextFireTimes().length, 0);
    expect(totalRegistered, 'total 18 crons registered across all schedulers').toBe(18);

    schedulers.forEach(s => s.stop());
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: 72-hour simulation
// ---------------------------------------------------------------------------

describe('Scenario 3: 72-hour simulation', () => {
  it('every cron fires the expected number of times; no cross-agent event leakage', async () => {
    // Migrate all agents
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
      const configPath = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', fixture.name, 'config.json');
      migrateCronsForAgent(fixture.name, configPath, tmpCtxRoot, { log: () => {} });
    }

    // Shared event log and per-agent fire count tracking
    const eventLog: FireEvent[] = [];
    const fireCounts: Map<string, number> = new Map(); // key: "agent/cronName"

    for (const fixture of AGENT_FIXTURES) {
      for (const c of fixture.crons) {
        fireCounts.set(`${fixture.name}/${c.name}`, 0);
      }
    }

    // Build and start one scheduler per agent; onFire records into the shared event log
    const schedulers: Array<{ fixture: AgentFixture; scheduler: InstanceType<typeof CronScheduler> }> = [];

    for (const fixture of AGENT_FIXTURES) {
      const s = new CronScheduler({
        agentName: fixture.name,
        onFire: (cron) => {
          const key = `${fixture.name}/${cron.name}`;
          fireCounts.set(key, (fireCounts.get(key) ?? 0) + 1);
          eventLog.push({ agent: fixture.name, cronName: cron.name, ts: Date.now() });
        },
        logger: () => {},
      });
      s.start();
      schedulers.push({ fixture, scheduler: s });
    }

    // Run 72-hour simulation in 1-minute steps
    await advanceSim(SIM_72H);

    schedulers.forEach(({ scheduler }) => scheduler.stop());

    // --- Assert: per-cron fire counts within expected range ---
    for (const [key, range] of Object.entries(CRON_EXPECTED_FIRES)) {
      const actual = fireCounts.get(key) ?? 0;
      expect(actual, `${key}: fires (${actual}) should be in [${range.min}, ${range.max}]`)
        .toBeGreaterThanOrEqual(range.min);
      expect(actual, `${key}: fires (${actual}) should be in [${range.min}, ${range.max}]`)
        .toBeLessThanOrEqual(range.max);
    }

    // --- Assert: total fires is within plausible range ---
    // Minimum: all interval-based crons at their exact rates (no boundary losses)
    // Maximum: interval crons + cron-expr crons each at their max
    const totalActual = [...fireCounts.values()].reduce((a, b) => a + b, 0);
    // Conservative bounds: at least 580, at most 700 (accounts for all tolerances)
    expect(totalActual, `total fires (${totalActual}) should be within plausible range`)
      .toBeGreaterThanOrEqual(580);
    expect(totalActual, `total fires (${totalActual}) should be within plausible range`)
      .toBeLessThanOrEqual(700);

    // --- Assert: no cross-agent event leakage ---
    // Every event in the log belongs to the agent that fired it
    const agentCronSets: Record<string, Set<string>> = {};
    for (const fixture of AGENT_FIXTURES) {
      agentCronSets[fixture.name] = new Set(fixture.crons.map(c => c.name));
    }

    for (const event of eventLog) {
      const validCrons = agentCronSets[event.agent];
      expect(validCrons, `event log: agent "${event.agent}" exists in fixtures`).toBeDefined();
      expect(
        validCrons.has(event.cronName),
        `event log: cron "${event.cronName}" in event from "${event.agent}" belongs to that agent`,
      ).toBe(true);
    }

    // --- Assert: events from agent A never appear in agent B's fire counts ---
    // (already guaranteed by the cron set check above, but verify directly)
    const borisEvents    = eventLog.filter(e => e.agent === 'boris');
    const paulEvents     = eventLog.filter(e => e.agent === 'paul');
    const sentinelEvents = eventLog.filter(e => e.agent === 'sentinel');
    const donnaEvents    = eventLog.filter(e => e.agent === 'donna');
    const nickEvents     = eventLog.filter(e => e.agent === 'nick');

    for (const e of borisEvents) {
      expect(['heartbeat','pr-monitor','experiment-pr-cycle-time','experiment-task-completion-rate'])
        .toContain(e.cronName);
    }
    for (const e of paulEvents) {
      expect(['heartbeat','morning-review','evening-review','worker-monitor','human-task-sweep','draft-approval-check'])
        .toContain(e.cronName);
    }
    for (const e of sentinelEvents) {
      expect(['system-health-check','cron-gap-detector','upstream-sync']).toContain(e.cronName);
    }
    for (const e of donnaEvents) {
      expect(['inbox-sweep','draft-tracker']).toContain(e.cronName);
    }
    for (const e of nickEvents) {
      expect(['deliverables-watch','heartbeat','pipeline-check']).toContain(e.cronName);
    }
  }, 120_000); // allow 2 min real time for 72h sim
});

// ---------------------------------------------------------------------------
// Scenario 4: Cross-agent message passing still works
// ---------------------------------------------------------------------------

describe('Scenario 4: Cross-agent message passing still works', () => {
  it('sendMessage from boris to paul writes an inbox file; cron system has no effect on bus', () => {
    // Build bus paths for sender (boris) and receiver (paul)
    const borsisPaths = buildBusPaths('boris');
    const paulPaths   = buildBusPaths('paul');

    // Create inbox dirs
    mkdirSync(paulPaths.inbox, { recursive: true });

    // Send a message from boris to paul
    const msgId = sendMessage(borsisPaths, 'boris', 'paul', 'normal', 'deliverables-done 2026-04-30');
    expect(typeof msgId).toBe('string');
    expect(msgId.length).toBeGreaterThan(0);

    // Inbox dir should contain one .json file
    const { readdirSync } = require('fs') as typeof import('fs');
    const inboxFiles = readdirSync(paulPaths.inbox).filter((f: string) => f.endsWith('.json'));
    expect(inboxFiles.length, 'paul inbox has 1 message').toBe(1);

    // Parse and validate message content
    const msgContent = JSON.parse(readFileSync(join(paulPaths.inbox, inboxFiles[0]), 'utf-8'));
    expect(msgContent.from).toBe('boris');
    expect(msgContent.to).toBe('paul');
    expect(msgContent.priority).toBe('normal');
    expect(msgContent.text).toBe('deliverables-done 2026-04-30');
    expect(msgContent.id).toBe(msgId);
  });

  it('sendMessage from sentinel to donna also works (verifying bus not stomped by any cron module)', () => {
    const sentinelPaths = buildBusPaths('sentinel');
    const donnaPaths    = buildBusPaths('donna');

    mkdirSync(donnaPaths.inbox, { recursive: true });

    const msgId = sendMessage(sentinelPaths, 'sentinel', 'donna', 'high', 'system-alert: cron gap detected');
    expect(msgId).toBeTruthy();

    const { readdirSync } = require('fs') as typeof import('fs');
    const files = readdirSync(donnaPaths.inbox).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    // High priority messages get pnum=1 prefix
    expect(files[0]).toMatch(/^1-/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Idempotent re-migration
// ---------------------------------------------------------------------------

describe('Scenario 5: Idempotent re-migration', () => {
  it('running migration twice produces no duplicate crons; marker mtime does not change', () => {
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
    }

    const logs: string[] = [];

    // First migration pass
    for (const fixture of AGENT_FIXTURES) {
      const configPath = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', fixture.name, 'config.json');
      migrateCronsForAgent(fixture.name, configPath, tmpCtxRoot, { log: (msg) => logs.push(msg) });
    }

    // Record marker mtime AFTER first pass
    const mtimesAfterFirst: Record<string, number> = {};
    for (const fixture of AGENT_FIXTURES) {
      const markerPath = join(tmpCtxRoot, CRONS_DIR, fixture.name, MARKER_FILE);
      mtimesAfterFirst[fixture.name] = statSync(markerPath).mtimeMs;
    }

    // Record crons.json cron counts after first pass
    const cronCountsAfterFirst: Record<string, number> = {};
    for (const fixture of AGENT_FIXTURES) {
      cronCountsAfterFirst[fixture.name] = readCrons(fixture.name).length;
    }

    // Second migration pass (without force — should be skipped)
    const secondPassLogs: string[] = [];
    for (const fixture of AGENT_FIXTURES) {
      const configPath = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', fixture.name, 'config.json');
      const result = migrateCronsForAgent(fixture.name, configPath, tmpCtxRoot, { log: (msg) => secondPassLogs.push(msg) });
      expect(result.status, `${fixture.name}: second pass should be skipped`).toBe('skipped-already-migrated');
    }

    // Cron counts unchanged — no duplicates
    for (const fixture of AGENT_FIXTURES) {
      const afterSecond = readCrons(fixture.name).length;
      expect(afterSecond, `${fixture.name}: no duplicate crons after 2nd migration`)
        .toBe(cronCountsAfterFirst[fixture.name]);
    }

    // Marker mtimes unchanged (second pass did not touch marker files)
    for (const fixture of AGENT_FIXTURES) {
      const markerPath = join(tmpCtxRoot, CRONS_DIR, fixture.name, MARKER_FILE);
      const mtimeAfterSecond = statSync(markerPath).mtimeMs;
      expect(mtimeAfterSecond, `${fixture.name}: marker mtime unchanged after skipped 2nd migration`)
        .toBe(mtimesAfterFirst[fixture.name]);
    }

    // All 5 second-pass log messages mention "already migrated" or "Skipping"
    expect(secondPassLogs.some(l => l.includes('already migrated') || l.includes('Skipping')))
      .toBe(true);
  });

  it('migrateAllAgents() also skips already-migrated agents in second pass', () => {
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
    }

    // First pass via all-agents
    const first = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, { log: () => {} });
    expect(first.totalCronsMigrated).toBe(18);

    // Second pass via all-agents
    const second = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, { log: () => {} });
    expect(second.totalCronsMigrated).toBe(0); // all skipped
    for (const r of second.results) {
      expect(r.status, `${r.agentName}: skipped on 2nd all-agents pass`).toBe('skipped-already-migrated');
    }

    // Still exactly 18 crons total on disk (no duplicates)
    const totalOnDisk = AGENT_FIXTURES.reduce((sum, f) => sum + readCrons(f.name).length, 0);
    expect(totalOnDisk, 'still 18 total crons on disk after 2nd pass').toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Per-agent log files written correctly
// ---------------------------------------------------------------------------

describe('Scenario 6: Per-agent log files written correctly', () => {
  it('after 72h sim, each agent log contains only its own crons; fired count matches fireCounts', async () => {
    for (const fixture of AGENT_FIXTURES) {
      writeAgentConfig(fixture);
      const configPath = join(tmpFrameworkRoot, 'orgs', 'lifeos', 'agents', fixture.name, 'config.json');
      migrateCronsForAgent(fixture.name, configPath, tmpCtxRoot, { log: () => {} });
    }

    const fireCounts: Map<string, number> = new Map();
    for (const fixture of AGENT_FIXTURES) {
      for (const c of fixture.crons) {
        fireCounts.set(`${fixture.name}/${c.name}`, 0);
      }
    }

    const schedulers: InstanceType<typeof CronScheduler>[] = [];

    for (const fixture of AGENT_FIXTURES) {
      const s = new CronScheduler({
        agentName: fixture.name,
        onFire: (cron) => {
          const key = `${fixture.name}/${cron.name}`;
          fireCounts.set(key, (fireCounts.get(key) ?? 0) + 1);
        },
        logger: () => {},
      });
      s.start();
      schedulers.push(s);
    }

    await advanceSim(SIM_72H);

    schedulers.forEach(s => s.stop());

    // Build the set of cron names known to each agent
    const knownCrons: Record<string, Set<string>> = {};
    for (const fixture of AGENT_FIXTURES) {
      knownCrons[fixture.name] = new Set(fixture.crons.map(c => c.name));
    }

    for (const fixture of AGENT_FIXTURES) {
      const agentName   = fixture.name;
      const logPath     = join(tmpCtxRoot, '.cortextOS', 'state', 'agents', agentName, 'cron-execution.log');

      // Log file exists if there were any fires
      const totalFires = [...fireCounts.entries()]
        .filter(([k]) => k.startsWith(`${agentName}/`))
        .reduce((sum, [, v]) => sum + v, 0);

      if (totalFires > 0) {
        expect(existsSync(logPath), `${agentName}: log file exists when fires occurred`).toBe(true);
      }

      // Every entry's cron belongs to this agent's known cron list (no cross-contamination)
      const entries = readLog(agentName);
      for (const entry of entries) {
        expect(
          knownCrons[agentName].has(entry.cron),
          `${agentName} log: entry cron "${entry.cron}" should belong to this agent`,
        ).toBe(true);
      }

      // Fired entry count per cron matches fireCounts
      for (const cronName of knownCrons[agentName]) {
        const key          = `${agentName}/${cronName}`;
        const expectedFires = fireCounts.get(key) ?? 0;
        const loggedFires   = entries.filter(e => e.cron === cronName && e.status === 'fired').length;
        expect(
          loggedFires,
          `${agentName}/${cronName}: log fired count (${loggedFires}) matches actual fires (${expectedFires})`,
        ).toBe(expectedFires);
      }
    }
  }, 120_000); // allow 2 min real time
});

// ---------------------------------------------------------------------------
// Scenario 7: Concurrent scheduler ticks don't corrupt crons.json
// ---------------------------------------------------------------------------

describe('Scenario 7: Concurrent scheduler ticks don\'t corrupt crons.json', () => {
  it('3 agents firing at the same tick update last_fired_at correctly; crons.json parses cleanly', async () => {
    // Choose 3 agents (boris, paul sentinel) and give each agent one cron
    // set to fire 25h ago so they all catch-up fire on the first tick.
    const agentsUnderTest = ['boris-conc', 'paul-conc', 'sentinel-conc'] as const;
    const pastFiredAt = new Date(Date.now() - 25 * ONE_HOUR).toISOString();

    for (const agentName of agentsUnderTest) {
      ensureAgentStateDir(agentName);
      // Add a single catch-up cron (was due 25h ago)
      addCron(agentName, {
        name: 'concurrent-cron',
        prompt: `Concurrent fire test for ${agentName}`,
        schedule: '24h',
        enabled: true,
        created_at: new Date().toISOString(),
        last_fired_at: pastFiredAt,
      });
    }

    const firedCounts: Map<string, number> = new Map(agentsUnderTest.map(a => [a, 0]));

    const schedulers: InstanceType<typeof CronScheduler>[] = [];
    for (const agentName of agentsUnderTest) {
      const s = new CronScheduler({
        agentName,
        onFire: () => {
          firedCounts.set(agentName, (firedCounts.get(agentName) ?? 0) + 1);
        },
        logger: () => {},
      });
      s.start();
      schedulers.push(s);
    }

    // First tick: all 3 crons have nextFireAt = now (catch-up) → all fire concurrently
    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000);

    schedulers.forEach(s => s.stop());

    // Each agent should have fired exactly once
    for (const agentName of agentsUnderTest) {
      expect(firedCounts.get(agentName), `${agentName}: fired once`).toBe(1);
    }

    // After concurrent fires, atomically read each crons.json — no parse errors, last_fired_at updated
    for (const agentName of agentsUnderTest) {
      const raw = rawCronsJson(agentName);
      expect(raw, `${agentName}: crons.json parseable`).not.toBeNull();
      expect(raw!.crons, `${agentName}: crons.json has 1 cron`).toHaveLength(1);

      const cron = raw!.crons[0];
      expect(cron.name).toBe('concurrent-cron');
      expect(cron.last_fired_at, `${agentName}: last_fired_at updated from pastFiredAt`).not.toBe(pastFiredAt);
      expect(cron.fire_count, `${agentName}: fire_count is 1`).toBe(1);

      // Verify last_fired_at is a valid ISO string
      const ts = Date.parse(cron.last_fired_at!);
      expect(Number.isFinite(ts), `${agentName}: last_fired_at is a valid ISO timestamp`).toBe(true);
    }

    // Verify no JSON parse errors by re-reading via readCrons()
    for (const agentName of agentsUnderTest) {
      const crons = readCrons(agentName);
      expect(crons, `${agentName}: readCrons returns valid array`).toHaveLength(1);
      expect(crons[0].name).toBe('concurrent-cron');
    }
  });

  it('5 agents each with 3 crons firing at same simulated minute: no lost updates', async () => {
    // Every cron starts 25h overdue so all 15 catch-up fire on tick 1
    const pastFiredAt = new Date(Date.now() - 25 * ONE_HOUR).toISOString();

    const testAgents = ['conc-a', 'conc-b', 'conc-c', 'conc-d', 'conc-e'] as const;
    const cronNamesPerAgent = ['alpha', 'beta', 'gamma'];

    for (const agentName of testAgents) {
      ensureAgentStateDir(agentName);
      for (const cronName of cronNamesPerAgent) {
        addCron(agentName, {
          name: cronName,
          prompt: `Concurrent cron ${cronName} for ${agentName}`,
          schedule: '24h',
          enabled: true,
          created_at: new Date().toISOString(),
          last_fired_at: pastFiredAt,
        });
      }
    }

    const totalFiredByAgent: Map<string, number> = new Map(testAgents.map(a => [a, 0]));

    const schedulers: InstanceType<typeof CronScheduler>[] = [];
    for (const agentName of testAgents) {
      const s = new CronScheduler({
        agentName,
        onFire: () => {
          totalFiredByAgent.set(agentName, (totalFiredByAgent.get(agentName) ?? 0) + 1);
        },
        logger: () => {},
      });
      s.start();
      schedulers.push(s);
    }

    // One tick: all 5 schedulers fire all 3 crons concurrently
    await vi.advanceTimersByTimeAsync(TICK_MS + 2_000);

    schedulers.forEach(s => s.stop());

    // Every agent should have fired all 3 crons
    for (const agentName of testAgents) {
      expect(totalFiredByAgent.get(agentName), `${agentName}: 3 fires`).toBe(3);
    }

    // crons.json for every agent must be parseable and have all 3 crons with fire_count=1
    for (const agentName of testAgents) {
      const crons = readCrons(agentName);
      expect(crons, `${agentName}: still 3 crons after concurrent tick`).toHaveLength(3);
      for (const c of crons) {
        expect(c.fire_count, `${agentName}/${c.name}: fire_count=1`).toBe(1);
        expect(c.last_fired_at, `${agentName}/${c.name}: last_fired_at updated`).not.toBe(pastFiredAt);
      }
    }
  });
});
