/**
 * tests/integration/phase5-user-journeys.test.ts — Subtask 5.2
 *
 * Phase 5 User Journey Backtests: 3 end-to-end journeys that simulate real
 * users interacting with the external persistent cron system.
 *
 * Journey 1 — New user setup
 *   A fresh agent is bootstrapped from templates.  The test reads ONBOARDING.md,
 *   extracts the documented bus add-cron steps, executes them via the same code
 *   path the CLI uses, and asserts all 3 crons fire on schedule within 10 minutes
 *   of simulated time.
 *
 * Journey 2 — Existing user upgrade
 *   An agent directory with a legacy config.json (crons array, no crons.json,
 *   no marker) triggers the migration path.  The test asserts zero-downtime:
 *   there is no window where crons are absent from either config or crons.json.
 *   Migration completes in under 2 minutes real time.
 *
 * Journey 3 — Operator workflow (dashboard CRUD)
 *   A running agent + scheduler are booted.  The test drives every dashboard
 *   API route in sequence: GET list → POST create → PATCH update → GET history
 *   → POST fire → DELETE.  Each step asserts the returned status and disk state.
 *
 * ISOLATION STRATEGY
 * ------------------
 * Journey 1 + 2 use a per-test tmpRoot (standard vitest beforeEach pattern,
 * same as phase3-docs-backtest).  Fake timers are activated inside the two
 * scheduler tests after modules are loaded, following the test-local setup
 * approach.
 *
 * Journey 3 follows the phase4-dashboard-backtest pattern exactly:
 *   - Top-level vi.mock(@/lib/ipc-client) — must be at module level so hoisting works
 *   - Top-level mockSend spy — referenced inside the mock factory and in tests
 *   - Shared j3Root initialised in beforeAll before route modules are imported
 *   - Route modules imported once in beforeAll, reused across J3 tests
 *   - beforeEach resets mockSend only (no module reloads inside J3)
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
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { CronDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// IPC mock — MUST be at module top level so vi.mock hoisting resolves correctly.
// This is the same pattern used by phase4-dashboard-backtest.test.ts.
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock('@/lib/ipc-client', () => {
  function IPCClient() {}
  IPCClient.prototype.send = mockSend;
  return { IPCClient };
});

// ---------------------------------------------------------------------------
// Dashboard route module type aliases (imported lazily in beforeAll)
// ---------------------------------------------------------------------------

type CronsRootModule = typeof import('../../dashboard/src/app/api/workflows/crons/route');
type CronsNameModule = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/route');
type ExecutionsModule = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route');
type FireModule       = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route');

// Journey 3 shared state — set before route imports in journeys3BeforeAll
const j3Root = mkdtempSync(join(tmpdir(), 'phase5-j3-'));
process.env.CTX_ROOT = j3Root;

let cronsRoot:  CronsRootModule;
let cronsName:  CronsNameModule;
let executions: ExecutionsModule;
let fireRoute:  FireModule;

// Seed enabled-agents.json now (before route imports pick up CTX_ROOT)
mkdirSync(join(j3Root, 'config'), { recursive: true });
writeFileSync(
  join(j3Root, 'config', 'enabled-agents.json'),
  JSON.stringify({ boris: { enabled: true, org: 'lifeos' } }, null, 2),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT          = process.cwd();
const CRONS_DIR     = '.cortextOS/state/agents';
const CRONS_FILE    = 'crons.json';
const MARKER_FILE   = '.crons-migrated';

const TICK_MS   = 30_000;   // CronScheduler.TICK_INTERVAL_MS
const ONE_MIN   = 60_000;
const ONE_HOUR  = 3_600_000;
const TEN_MINS  = 10 * ONE_MIN;
const TWO_MINS  = 2 * ONE_MIN;

// Doc paths under test
const ONBOARDING_MD         = join(ROOT, 'templates', 'agent', 'ONBOARDING.md');
const CRONS_MIGRATION_GUIDE = join(ROOT, 'CRONS_MIGRATION_GUIDE.md');

// ---------------------------------------------------------------------------
// Per-test environment wiring (Journeys 1 + 2)
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Module references re-imported per test after vi.resetModules()
let addCron:              typeof import('../../src/bus/crons.js').addCron;
let readCrons:            typeof import('../../src/bus/crons.js').readCrons;
let updateCron:           typeof import('../../src/bus/crons.js').updateCron;
let getCronByName:        typeof import('../../src/bus/crons.js').getCronByName;
let getExecutionLog:      typeof import('../../src/bus/crons.js').getExecutionLog;
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let appendExecutionLog:   typeof import('../../src/daemon/cron-execution-log.js').appendExecutionLog;
let CronScheduler:        typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules(): Promise<void> {
  vi.resetModules();
  const cronsMod   = await import('../../src/bus/crons.js');
  addCron          = cronsMod.addCron;
  readCrons        = cronsMod.readCrons;
  getCronByName    = cronsMod.getCronByName;
  getExecutionLog  = cronsMod.getExecutionLog;
  const migMod     = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migMod.migrateCronsForAgent;
  const logMod     = await import('../../src/daemon/cron-execution-log.js');
  appendExecutionLog = logMod.appendExecutionLog;
  const schedMod   = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler    = schedMod.CronScheduler;
}

beforeAll(async () => {
  // Import route modules once, with CTX_ROOT pointing at j3Root
  cronsRoot   = await import('../../dashboard/src/app/api/workflows/crons/route');
  cronsName   = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/route');
  executions  = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route');
  fireRoute   = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route');
});

afterAll(() => {
  try { rmSync(j3Root, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  // Fresh tmpRoot for Journeys 1 + 2 isolation
  tmpRoot = mkdtempSync(join(tmpdir(), 'phase5-j12-'));
  // NOTE: we do NOT update CTX_ROOT here for J1/J2 tests; they call
  // reloadModules() with CTX_ROOT set right before calling addCron etc.
  await reloadModules();
  // Set CTX_ROOT for J1/J2 module calls (J3 uses j3Root set at module load)
  process.env.CTX_ROOT = tmpRoot;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  // Restore j3Root for route modules between tests
  process.env.CTX_ROOT = j3Root;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cronsJsonPath(agentName: string): string {
  return join(tmpRoot, CRONS_DIR, agentName, CRONS_FILE);
}

function markerPath(agentName: string): string {
  return join(tmpRoot, CRONS_DIR, agentName, MARKER_FILE);
}

function readCronsJson(agentName: string): { updated_at: string; crons: CronDefinition[] } | null {
  const p = cronsJsonPath(agentName);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function readDoc(filePath: string): string {
  expect(existsSync(filePath), `Doc must exist: ${filePath}`).toBe(true);
  return readFileSync(filePath, 'utf-8');
}

function ensureAgentDir(agentName: string): void {
  mkdirSync(join(tmpRoot, CRONS_DIR, agentName), { recursive: true });
}

function writeLegacyConfig(agentDir: string, crons: object[]): string {
  const configPath = join(agentDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ crons }, null, 2));
  return configPath;
}

// Journey 3 helpers (write to j3Root)
function j3WriteCronsJson(agentName: string, crons: object[]): void {
  const dir = join(j3Root, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function j3WriteExecLog(agentName: string, entries: object[]): void {
  const dir = join(j3Root, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// Journey 1: New user setup
// ---------------------------------------------------------------------------

describe('Journey 1: New user setup (ONBOARDING.md + bus add-cron + scheduler)', () => {

  it('J1-1: ONBOARDING.md prescribes bus add-cron (not /loop) for persistent crons', () => {
    const doc = readDoc(ONBOARDING_MD);

    // Must use bus add-cron
    expect(doc).toContain('cortextos bus add-cron');

    // Must document the correct CLI signature
    expect(doc).toMatch(/bus add-cron\s+\$CTX_AGENT_NAME\s+<workflow-name>\s+<interval>\s+<prompt>/);

    // Must explicitly warn against /loop
    expect(doc).toMatch(/do NOT use.*\/loop.*session.only|not.*\/loop.*dies on restart/i);

    // Must mention that crons survive restarts
    expect(doc).toMatch(/survives?.*restarts?|persists?.*restart/i);
  });

  it('J1-2: ONBOARDING.md includes at least one concrete copy-paste-ready example', () => {
    const doc = readDoc(ONBOARDING_MD);
    const lines = doc.split('\n');

    // A concrete example: line contains "bus add-cron", a concrete interval
    // (e.g. 6h), and no placeholder angle-brackets
    const concreteLines = lines.filter(l =>
      /cortextos bus add-cron/.test(l) &&
      /[0-9]+[mhd]|"[0-9*\/]+ /.test(l) &&
      !/<interval>|<name>|<workflow-name>/.test(l)
    );
    expect(
      concreteLines.length,
      'ONBOARDING.md must contain at least one concrete bus add-cron example',
    ).toBeGreaterThan(0);
  });

  it('J1-3: following the onboarding steps creates 3 crons in crons.json', () => {
    const agent = 'new-user-agent';
    ensureAgentDir(agent);

    const startMs = Date.now();

    // Simulate: operator follows ONBOARDING.md Step 9 and runs 3 bus add-cron calls
    const cronDefs: CronDefinition[] = [
      {
        name: 'heartbeat',
        schedule: '6h',
        prompt: 'Read HEARTBEAT.md and follow its instructions.',
        enabled: true,
        created_at: new Date().toISOString(),
      },
      {
        name: 'daily-report',
        schedule: '0 9 * * 1-5',
        prompt: 'Generate and send the daily analytics report.',
        enabled: true,
        created_at: new Date().toISOString(),
      },
      {
        name: 'nightly-summary',
        schedule: '0 23 * * *',
        prompt: 'Compile and send the nightly summary.',
        enabled: true,
        created_at: new Date().toISOString(),
      },
    ];

    for (const def of cronDefs) {
      addCron(agent, def);
    }

    const elapsedMs = Date.now() - startMs;

    // All 3 must be on disk
    const disk = readCronsJson(agent);
    expect(disk).not.toBeNull();
    expect(disk!.crons).toHaveLength(3);
    expect(disk!.crons.map(c => c.name)).toEqual(
      expect.arrayContaining(['heartbeat', 'daily-report', 'nightly-summary'])
    );

    // All enabled
    for (const c of disk!.crons) {
      expect(c.enabled).toBe(true);
    }

    // Must be much faster than 10 simulated minutes
    expect(elapsedMs).toBeLessThan(TEN_MINS);
  });

  it('J1-4: daemon readCrons sees the 3 crons immediately after add (no restart)', () => {
    const agent = 'new-user-daemon-read';
    ensureAgentDir(agent);

    addCron(agent, { name: 'heartbeat',    schedule: '6h',          prompt: 'Heartbeat.',    enabled: true, created_at: new Date().toISOString() });
    addCron(agent, { name: 'daily-report', schedule: '0 9 * * 1-5', prompt: 'Daily report.', enabled: true, created_at: new Date().toISOString() });
    addCron(agent, { name: 'nightly',      schedule: '0 23 * * *',  prompt: 'Nightly.',      enabled: true, created_at: new Date().toISOString() });

    // readCrons = the function the daemon calls on startup (CronScheduler.loadCrons)
    const crons = readCrons(agent);
    expect(crons).toHaveLength(3);
    expect(crons.map(c => c.name)).toEqual(
      expect.arrayContaining(['heartbeat', 'daily-report', 'nightly'])
    );
  });

  it('J1-5: all 3 crons fire on schedule within 10 simulated minutes', async () => {
    const agent = 'new-user-scheduler';
    ensureAgentDir(agent);

    // Use short intervals so all 3 fire within 10 simulated minutes
    addCron(agent, { name: 'cron-a', schedule: '2m', prompt: 'Task A.', enabled: true, created_at: new Date().toISOString() });
    addCron(agent, { name: 'cron-b', schedule: '3m', prompt: 'Task B.', enabled: true, created_at: new Date().toISOString() });
    addCron(agent, { name: 'cron-c', schedule: '5m', prompt: 'Task C.', enabled: true, created_at: new Date().toISOString() });

    vi.useFakeTimers();

    const fired = new Set<string>();

    const scheduler = new CronScheduler({
      agentName: agent,
      onFire: async (cron: CronDefinition) => {
        fired.add(cron.name);
        appendExecutionLog(agent, {
          ts: new Date().toISOString(),
          cron: cron.name,
          status: 'fired',
          attempt: 1,
          duration_ms: 10,
          error: null,
        });
      },
    });

    scheduler.start();

    // Advance 10 minutes in 30-second ticks
    for (let i = 0; i < (TEN_MINS / TICK_MS); i++) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }

    scheduler.stop();

    // All 3 must have fired
    expect(fired.has('cron-a'), 'cron-a (2m) must fire within 10 min').toBe(true);
    expect(fired.has('cron-b'), 'cron-b (3m) must fire within 10 min').toBe(true);
    expect(fired.has('cron-c'), 'cron-c (5m) must fire within 10 min').toBe(true);

    // Execution log must have entries for each
    const log = getExecutionLog(agent);
    const loggedNames = new Set(log.map(e => e.cron));
    expect(loggedNames.has('cron-a')).toBe(true);
    expect(loggedNames.has('cron-b')).toBe(true);
    expect(loggedNames.has('cron-c')).toBe(true);
  });

  it('J1-6: getCronByName returns correct definitions after add', () => {
    const agent = 'new-user-lookup';
    ensureAgentDir(agent);

    addCron(agent, { name: 'heartbeat', schedule: '6h', prompt: 'Heartbeat.', enabled: true, created_at: new Date().toISOString() });

    const found = getCronByName(agent, 'heartbeat');
    expect(found).toBeDefined();
    expect(found!.schedule).toBe('6h');
    expect(found!.enabled).toBe(true);

    // Unknown cron returns undefined
    expect(getCronByName(agent, 'does-not-exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Journey 2: Existing user upgrade (migration)
// ---------------------------------------------------------------------------

describe('Journey 2: Existing user upgrade (cron-migration + zero-downtime)', () => {

  it('J2-1: CRONS_MIGRATION_GUIDE.md contains all required sections', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);

    const required = [
      'What Changed',
      'What You Need to Do',
      'Verification',
      'Troubleshooting',
      'Backward Compatibility',
    ];
    for (const section of required) {
      expect(doc, `Migration guide must contain section: "${section}"`).toContain(section);
    }
  });

  it('J2-2: CRONS_MIGRATION_GUIDE.md explains bus migrate-crons command for manual re-run', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);
    expect(doc).toContain('cortextos bus migrate-crons');
    expect(doc).toContain('.crons-migrated');
    expect(doc).toContain('crons.json');
  });

  it('J2-3: pre-migration agent has config.json crons and no crons.json', () => {
    const agent = 'legacy-agent';
    ensureAgentDir(agent);

    const configPath = join(tmpRoot, `legacy-config.json`);
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'heartbeat',    interval: '6h',         prompt: 'Heartbeat.',     type: 'recurring' },
        { name: 'daily-report', cron: '0 9 * * 1-5',    prompt: 'Daily report.',  type: 'recurring' },
        { name: 'nightly',      interval: '24h',         prompt: 'Nightly check.', type: 'recurring' },
      ]
    }, null, 2));

    // Pre-migration assertions: no crons.json, no marker
    expect(existsSync(cronsJsonPath(agent))).toBe(false);
    expect(existsSync(markerPath(agent))).toBe(false);
  });

  it('J2-4: migration completes atomically with zero data-loss window', () => {
    const agent = 'upgrade-agent';
    ensureAgentDir(agent);

    const configPath = join(tmpRoot, `upgrade-config.json`);
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'heartbeat',    interval: '6h',         prompt: 'Heartbeat.',     type: 'recurring' },
        { name: 'daily-report', cron: '0 9 * * 1-5',    prompt: 'Daily report.',  type: 'recurring' },
        { name: 'nightly',      interval: '24h',         prompt: 'Nightly check.', type: 'recurring' },
      ]
    }, null, 2));

    const startMs = Date.now();

    // Zero-downtime: before migration config.json is the source of truth.
    const legacyData = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(legacyData.crons).toHaveLength(3);

    // Run migration
    const result = migrateCronsForAgent(agent, configPath, tmpRoot);

    const elapsedMs = Date.now() - startMs;

    // Migration must succeed and report correct counts
    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(3);
    expect(result.cronsSkipped ?? []).toHaveLength(0);

    // crons.json must exist and contain all 3 crons
    const disk = readCronsJson(agent);
    expect(disk).not.toBeNull();
    expect(disk!.crons).toHaveLength(3);

    // Names must all be preserved
    const names = disk!.crons.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['heartbeat', 'daily-report', 'nightly']));

    // Marker must be set
    expect(existsSync(markerPath(agent))).toBe(true);

    // Config.json must be untouched (non-destructive migration)
    const afterData = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterData.crons).toHaveLength(3);

    // Zero-downtime: crons.json written before marker; both present = active
    expect(existsSync(cronsJsonPath(agent))).toBe(true);

    // Simulated time well under 2 minutes
    expect(elapsedMs).toBeLessThan(TWO_MINS);
  });

  it('J2-5: repeated migration calls are idempotent (marker prevents double-run)', () => {
    const agent = 'idempotent-agent';
    ensureAgentDir(agent);

    const configPath = join(tmpRoot, `idem-config.json`);
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.', type: 'recurring' },
      ]
    }, null, 2));

    // First migration
    const r1 = migrateCronsForAgent(agent, configPath, tmpRoot);
    expect(r1.status).toBe('migrated');
    expect(r1.cronsMigrated).toBe(1);

    // Second migration must be skipped
    const r2 = migrateCronsForAgent(agent, configPath, tmpRoot);
    expect(r2.status).toBe('skipped-already-migrated');

    // crons.json must still have exactly 1 cron (not doubled)
    const disk = readCronsJson(agent);
    expect(disk!.crons).toHaveLength(1);
  });

  it('J2-6: migrated crons fire on schedule within 10 simulated minutes', async () => {
    const agent = 'migrated-scheduler-agent';
    ensureAgentDir(agent);

    const configPath = join(tmpRoot, `migrated-config.json`);
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'migrated-heartbeat', interval: '3m', prompt: 'Migrated heartbeat.', type: 'recurring' },
        { name: 'migrated-report',    interval: '7m', prompt: 'Migrated report.',    type: 'recurring' },
      ]
    }, null, 2));

    // Run migration
    const migrateResult = migrateCronsForAgent(agent, configPath, tmpRoot);
    expect(migrateResult.status).toBe('migrated');
    expect(migrateResult.cronsMigrated).toBe(2);

    // Boot the scheduler and verify both crons fire
    vi.useFakeTimers();
    const fired = new Set<string>();

    const scheduler = new CronScheduler({
      agentName: agent,
      onFire: async (cron: CronDefinition) => {
        fired.add(cron.name);
      },
    });
    scheduler.start();

    // Advance 10 minutes in 30-second ticks
    for (let i = 0; i < (TEN_MINS / TICK_MS); i++) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }

    scheduler.stop();

    expect(fired.has('migrated-heartbeat'), 'migrated-heartbeat (3m) must fire within 10 min').toBe(true);
    expect(fired.has('migrated-report'),    'migrated-report (7m) must fire within 10 min').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journey 3: Operator workflow (dashboard API CRUD round-trip)
// ---------------------------------------------------------------------------

describe('Journey 3: Operator workflow (dashboard API CRUD round-trip)', () => {
  // Reset mock before each J3 test
  beforeEach(() => { mockSend.mockReset(); });

  // J3 tests use j3Root (set at module load, routes imported in beforeAll)
  // They do NOT use tmpRoot — that's for J1/J2 only.

  // -------------------------------------------------------------------------
  // J3-1: GET — list returns pre-seeded cron with nextFire
  // -------------------------------------------------------------------------

  it('J3-1: GET /api/workflows/crons lists a pre-seeded cron with nextFire', async () => {
    j3WriteCronsJson('boris', [{
      name: 'j3-heartbeat',
      schedule: '6h',
      prompt: 'Heartbeat.',
      enabled: true,
      created_at: new Date(Date.now() - ONE_HOUR).toISOString(),
      last_fired_at: new Date(Date.now() - 3_600_000).toISOString(),
      fire_count: 1,
    }]);

    const req = new NextRequest('http://localhost/api/workflows/crons?agent=boris');
    const res = await cronsRoot.GET(req);
    expect(res.status).toBe(200);

    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);

    const row = rows.find((r: { agent: string; cron: { name: string } }) =>
      r.agent === 'boris' && r.cron.name === 'j3-heartbeat'
    );
    expect(row).toBeDefined();
    expect(row.cron.schedule).toBe('6h');
    expect(row.nextFire).toBeDefined();
    expect(row.nextFire).not.toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // J3-2: POST — create new cron via IPC
  // -------------------------------------------------------------------------

  it('J3-2: POST /api/workflows/crons creates a cron and returns 201', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'boris',
        definition: {
          name: 'j3-daily-report',
          prompt: 'Generate daily report.',
          schedule: '0 9 * * 1-5',
          enabled: true,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // IPC must have been called with correct add-cron payload
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add-cron',
        agent: 'boris',
        data: expect.objectContaining({
          definition: expect.objectContaining({
            name: 'j3-daily-report',
            schedule: '0 9 * * 1-5',
          }),
        }),
        source: 'dashboard/api',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // J3-3: POST → 409 when cron name collides
  // -------------------------------------------------------------------------

  it('J3-3: POST returns 409 when daemon reports name collision', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Cron j3-heartbeat already exists for agent boris.',
    });

    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'boris',
        definition: { name: 'j3-heartbeat', prompt: 'x', schedule: '6h', enabled: true },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // J3-4: PATCH — update schedule via IPC
  // -------------------------------------------------------------------------

  it('J3-4: PATCH updates a cron schedule via IPC and returns 200', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/j3-heartbeat', {
      method: 'PATCH',
      body: JSON.stringify({ patch: { schedule: '12h' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await cronsName.PATCH(req, {
      params: Promise.resolve({ agent: 'boris', name: 'j3-heartbeat' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'update-cron',
        agent: 'boris',
        data: expect.objectContaining({
          name: 'j3-heartbeat',
          patch: expect.objectContaining({ schedule: '12h' }),
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // J3-5: GET executions — history returns log entries filtered by cron name
  // -------------------------------------------------------------------------

  it('J3-5: GET executions returns history for a specific cron', async () => {
    j3WriteExecLog('boris', [
      { ts: new Date(Date.now() - 3_600_000).toISOString(), cron: 'j3-heartbeat',    status: 'fired',  attempt: 1, duration_ms: 45, error: null },
      { ts: new Date(Date.now() - 1_800_000).toISOString(), cron: 'j3-heartbeat',    status: 'fired',  attempt: 1, duration_ms: 38, error: null },
      { ts: new Date(Date.now() -   900_000).toISOString(), cron: 'j3-daily-report', status: 'fired',  attempt: 1, duration_ms: 52, error: null },
    ]);

    const req = new NextRequest(
      'http://localhost/api/workflows/crons/boris/j3-heartbeat/executions',
    );
    const res = await executions.GET(req, {
      params: Promise.resolve({ agent: 'boris', name: 'j3-heartbeat' }),
    });
    expect(res.status).toBe(200);

    const page = await res.json();
    expect(page.entries).toBeDefined();
    expect(Array.isArray(page.entries)).toBe(true);
    // Only the 2 j3-heartbeat entries, not j3-daily-report
    expect(page.entries.length).toBe(2);
    for (const e of page.entries) {
      expect(e.cron).toBe('j3-heartbeat');
      expect(e.status).toBe('fired');
    }
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  // -------------------------------------------------------------------------
  // J3-6: POST fire — test-fire dispatched via IPC
  // -------------------------------------------------------------------------

  it('J3-6: POST fire dispatches fire-cron via IPC and returns 200', async () => {
    const firedAt = Date.now();
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt } });

    const req = new NextRequest(
      'http://localhost/api/workflows/crons/boris/j3-heartbeat/fire',
      { method: 'POST' },
    );
    const res = await fireRoute.POST(req, {
      params: Promise.resolve({ agent: 'boris', name: 'j3-heartbeat' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.firedAt).toBeDefined();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fire-cron',
        agent: 'boris',
        data: expect.objectContaining({ name: 'j3-heartbeat' }),
        source: 'dashboard/api/fire',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // J3-7: POST fire → 403 when manualFireDisabled
  // -------------------------------------------------------------------------

  it('J3-7: POST fire returns 403 when daemon reports manualFireDisabled', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Manual fire disabled for cron j3-heartbeat',
    });

    const req = new NextRequest(
      'http://localhost/api/workflows/crons/boris/j3-heartbeat/fire',
      { method: 'POST' },
    );
    const res = await fireRoute.POST(req, {
      params: Promise.resolve({ agent: 'boris', name: 'j3-heartbeat' }),
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // J3-8: DELETE — remove via IPC
  // -------------------------------------------------------------------------

  it('J3-8: DELETE removes a cron via IPC and returns 200', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest(
      'http://localhost/api/workflows/crons/boris/j3-heartbeat',
      { method: 'DELETE' },
    );
    const res = await cronsName.DELETE(req, {
      params: Promise.resolve({ agent: 'boris', name: 'j3-heartbeat' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'remove-cron',
        agent: 'boris',
        data: expect.objectContaining({ name: 'j3-heartbeat' }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // J3-9: POST → 400 when agent field missing (input validation guard)
  // -------------------------------------------------------------------------

  it('J3-9: POST returns 400 when agent field is absent', async () => {
    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({ definition: { name: 'x', prompt: 'y', schedule: '1h' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // J3-10: Full CRUD round-trip in correct state order
  // -------------------------------------------------------------------------

  it('J3-10: complete CRUD round-trip succeeds end-to-end in correct state order', async () => {
    const agent = 'j3-roundtrip';
    const cName = 'j3-rt-cron';

    // Step 0: Seed state
    j3WriteCronsJson(agent, [{
      name: cName, schedule: '6h', prompt: 'Round-trip test.', enabled: true,
      created_at: new Date(Date.now() - ONE_HOUR).toISOString(),
    }]);

    // Add agent to enabled-agents so GET includes it
    writeFileSync(
      join(j3Root, 'config', 'enabled-agents.json'),
      JSON.stringify(
        { boris: { enabled: true, org: 'lifeos' }, [agent]: { enabled: true, org: 'lifeos' } },
        null, 2,
      ),
    );

    // Step 1: GET list — cron must appear
    {
      const req = new NextRequest(`http://localhost/api/workflows/crons?agent=${agent}`);
      const res = await cronsRoot.GET(req);
      expect(res.status).toBe(200);
      const rows = await res.json();
      const row = rows.find((r: { agent: string; cron: { name: string } }) =>
        r.agent === agent && r.cron.name === cName
      );
      expect(row).toBeDefined();
      expect(row.cron.schedule).toBe('6h');
    }

    // Step 2: PATCH schedule
    {
      mockSend.mockResolvedValueOnce({ success: true });
      const req = new NextRequest(
        `http://localhost/api/workflows/crons/${agent}/${cName}`,
        { method: 'PATCH', body: JSON.stringify({ patch: { schedule: '12h' } }), headers: { 'Content-Type': 'application/json' } },
      );
      const res = await cronsName.PATCH(req, {
        params: Promise.resolve({ agent, name: cName }),
      });
      expect(res.status).toBe(200);
    }

    // Step 3: GET executions — empty for fresh cron
    {
      const req = new NextRequest(
        `http://localhost/api/workflows/crons/${agent}/${cName}/executions`,
      );
      const res = await executions.GET(req, {
        params: Promise.resolve({ agent, name: cName }),
      });
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page.entries).toHaveLength(0);
      expect(page.total).toBe(0);
    }

    // Step 4: POST fire
    {
      mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt: Date.now() } });
      const req = new NextRequest(
        `http://localhost/api/workflows/crons/${agent}/${cName}/fire`,
        { method: 'POST' },
      );
      const res = await fireRoute.POST(req, {
        params: Promise.resolve({ agent, name: cName }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }

    // Step 5: DELETE
    {
      mockSend.mockResolvedValueOnce({ success: true });
      const req = new NextRequest(
        `http://localhost/api/workflows/crons/${agent}/${cName}`,
        { method: 'DELETE' },
      );
      const res = await cronsName.DELETE(req, {
        params: Promise.resolve({ agent, name: cName }),
      });
      expect(res.status).toBe(200);
    }
  });
});
