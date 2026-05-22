/**
 * tests/integration/phase3-docs-backtest.test.ts — Subtask 3.5 Phase 3 Full Backtesting
 *
 * Programmatically follows the Phase 3 documentation workflows end-to-end.
 * Four scenarios mirror real user journeys described in the docs:
 *
 *   Scenario 1: New user onboarding — follows ONBOARDING.md Step 9 (bus add-cron)
 *   Scenario 2: Existing user upgrade — follows CRONS_MIGRATION_GUIDE.md migration path
 *   Scenario 3: Operator adds crons via skill docs — follows cron-management/SKILL.md
 *   Scenario 4: Support troubleshoots missing cron — follows Troubleshooting sections
 *
 * Each scenario:
 *   1. Reads the relevant doc from disk and asserts key prescriptive sections exist
 *   2. Programmatically executes the doc-prescribed steps in a tmp agent dir
 *   3. Asserts the documented outcome actually occurs
 *
 * ISOLATION
 * ---------
 * Each scenario gets its own tmpdir; CTX_ROOT is set before each test.
 * vi.resetModules() + re-import prevents module-level state leakage.
 *
 * NO FAKE TIMERS
 * --------------
 * These tests validate documentation clarity + bus command outcomes, not
 * timing behaviour. Real timers are used throughout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import type { CronDefinition, CronExecutionLogEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

const CRONS_DIR   = '.cortextOS/state/agents';
const CRONS_FILE  = 'crons.json';
const MARKER_FILE = '.crons-migrated';
const EXEC_LOG    = 'cron-execution.log';

// Doc paths under test
const ONBOARDING_MD        = join(ROOT, 'templates', 'agent', 'ONBOARDING.md');
const CRONS_MIGRATION_GUIDE = join(ROOT, 'CRONS_MIGRATION_GUIDE.md');
const SKILL_MD             = join(ROOT, 'community', 'skills', 'cron-management', 'SKILL.md');

// ---------------------------------------------------------------------------
// Per-test environment wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let addCron:      typeof import('../../src/bus/crons.js').addCron;
let readCrons:    typeof import('../../src/bus/crons.js').readCrons;
let removeCron:   typeof import('../../src/bus/crons.js').removeCron;
let updateCron:   typeof import('../../src/bus/crons.js').updateCron;
let getCronByName: typeof import('../../src/bus/crons.js').getCronByName;
let getExecutionLog: typeof import('../../src/bus/crons.js').getExecutionLog;
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let isMigrated:   typeof import('../../src/daemon/cron-migration.js').isMigrated;
let appendExecutionLog: typeof import('../../src/daemon/cron-execution-log.js').appendExecutionLog;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules(): Promise<void> {
  vi.resetModules();
  const cronsMod  = await import('../../src/bus/crons.js');
  addCron          = cronsMod.addCron;
  readCrons        = cronsMod.readCrons;
  removeCron       = cronsMod.removeCron;
  updateCron       = cronsMod.updateCron;
  getCronByName    = cronsMod.getCronByName;
  getExecutionLog  = cronsMod.getExecutionLog;
  const migMod    = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migMod.migrateCronsForAgent;
  isMigrated       = migMod.isMigrated;
  const logMod    = await import('../../src/daemon/cron-execution-log.js');
  appendExecutionLog = logMod.appendExecutionLog;
  const schedMod  = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler    = schedMod.CronScheduler;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'phase3-backtest-'));
  process.env.CTX_ROOT = tmpRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Doc helpers
// ---------------------------------------------------------------------------

function readDoc(filePath: string): string {
  expect(existsSync(filePath), `Doc file must exist: ${filePath}`).toBe(true);
  return readFileSync(filePath, 'utf-8');
}

function cronsJsonPath(agentName: string): string {
  return join(tmpRoot, CRONS_DIR, agentName, CRONS_FILE);
}

function markerPath(agentName: string): string {
  return join(tmpRoot, CRONS_DIR, agentName, MARKER_FILE);
}

function execLogPath(agentName: string): string {
  return join(tmpRoot, CRONS_DIR, agentName, EXEC_LOG);
}

function readCronsJson(agentName: string): { updated_at: string; crons: CronDefinition[] } | null {
  const p = cronsJsonPath(agentName);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function readExecLog(agentName: string): CronExecutionLogEntry[] {
  const p = execLogPath(agentName);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as CronExecutionLogEntry);
}

// ---------------------------------------------------------------------------
// Scenario 1: New user onboarding via ONBOARDING.md
// ---------------------------------------------------------------------------

describe('Scenario 1: New user onboarding (ONBOARDING.md Step 9)', () => {
  // ---- 1a: Doc content assertions ----------------------------------------

  it('1a: ONBOARDING.md exists and instructs bus add-cron for persistent crons', () => {
    const doc = readDoc(ONBOARDING_MD);

    // The doc must prescribe bus add-cron as the persistent cron creation command
    expect(doc).toContain('cortextos bus add-cron');

    // Must describe the command signature
    expect(doc).toMatch(/bus add-cron\s+\$CTX_AGENT_NAME\s+<workflow-name>\s+<interval>\s+<prompt>/);

    // Must warn against /loop for persistent work
    expect(doc).toMatch(/do NOT use.*\/loop.*session.only|not.*\/loop.*dies on restart/i);

    // Must mention that crons survive restarts
    expect(doc).toMatch(/survives?.*restarts?|persists?.*restart/i);
  });

  it('1b: onboarding example command is copy-paste ready (has concrete interval + prompt)', () => {
    const doc = readDoc(ONBOARDING_MD);

    // Look for a concrete interval shorthand in an add-cron line (not just <interval>)
    const lines = doc.split('\n');
    const concreteCronLines = lines.filter(l =>
      /cortextos bus add-cron/.test(l) &&
      /[0-9]+[mhd]|"[0-9*\/]+ /.test(l) &&
      !/<interval>|<name>|<workflow-name>/.test(l)
    );
    expect(concreteCronLines.length, 'ONBOARDING.md must have at least one concrete bus add-cron example').toBeGreaterThan(0);
  });

  // ---- 1c: Programmatic execution ----------------------------------------

  it('1c: following the documented steps creates crons.json with expected entry', () => {
    const agent = 'new-user-agent';

    // Step: create a fake agent dir (what daemon bootstrap would do)
    const agentStateDir = join(tmpRoot, CRONS_DIR, agent);
    mkdirSync(agentStateDir, { recursive: true });

    // Doc says: run `cortextos bus add-cron $CTX_AGENT_NAME <workflow-name> <interval> <prompt>`
    // We call the underlying addCron API directly (same code path as bus CLI)
    const cronDef: CronDefinition = {
      name: 'heartbeat',
      schedule: '6h',
      prompt: 'Read HEARTBEAT.md and follow its instructions.',
      enabled: true,
      created_at: new Date().toISOString(),
    };

    // Before: crons.json should not exist
    expect(existsSync(cronsJsonPath(agent))).toBe(false);

    addCron(agent, cronDef);

    // After: crons.json must exist (persistence assertion)
    expect(existsSync(cronsJsonPath(agent))).toBe(true);

    const diskData = readCronsJson(agent);
    expect(diskData).not.toBeNull();
    expect(diskData!.crons).toHaveLength(1);
    expect(diskData!.crons[0].name).toBe('heartbeat');
    expect(diskData!.crons[0].schedule).toBe('6h');
    expect(diskData!.crons[0].enabled).toBe(true);
  });

  it('1d: daemon can read the cron immediately after add — no restart needed', () => {
    const agent = 'new-user-agent-d';
    mkdirSync(join(tmpRoot, CRONS_DIR, agent), { recursive: true });

    addCron(agent, {
      name: 'daily-report',
      schedule: '0 9 * * 1-5',
      prompt: 'Generate and send daily analytics report.',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    // readCrons = the function the daemon calls on startup (CronScheduler.loadCrons)
    const crons = readCrons(agent);
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('daily-report');
    expect(crons[0].schedule).toBe('0 9 * * 1-5');
  });

  it('1e: getCronByName confirms lookup works (list-crons uses same path)', () => {
    const agent = 'new-user-agent-e';
    mkdirSync(join(tmpRoot, CRONS_DIR, agent), { recursive: true });

    addCron(agent, {
      name: 'weekly-summary',
      schedule: '0 17 * * 5',
      prompt: 'Compile and deliver the weekly summary.',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const found = getCronByName(agent, 'weekly-summary');
    expect(found).toBeDefined();
    expect(found!.schedule).toBe('0 17 * * 5');

    // Non-existent cron returns undefined
    expect(getCronByName(agent, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Existing user upgrade — migration guide
// ---------------------------------------------------------------------------

describe('Scenario 2: Existing user upgrade (CRONS_MIGRATION_GUIDE.md)', () => {
  // ---- 2a: Doc content assertions ----------------------------------------

  it('2a: CRONS_MIGRATION_GUIDE.md exists with all required sections', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);

    const requiredSections = [
      'What Changed',
      'What You Need to Do',
      'Verification',
      'Troubleshooting',
      'Backward Compatibility',
    ];
    for (const section of requiredSections) {
      expect(doc, `Migration guide must contain section: "${section}"`).toContain(section);
    }
  });

  it('2b: migration guide says migration is automatic (non-scary message)', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);

    // "Nothing. Migration runs automatically..."
    expect(doc).toMatch(/automatic|Nothing.*[Mm]igration runs/i);
    // Must reference .crons-migrated marker
    expect(doc).toContain('.crons-migrated');
    // Must reference crons.json as target
    expect(doc).toContain('crons.json');
    // config.json must be left untouched
    expect(doc).toMatch(/untouched|non.destructive|left unchanged/i);
  });

  it('2c: migration guide provides manual migration command', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);
    expect(doc).toContain('cortextos bus migrate-crons');
    expect(doc).toContain('--force');
  });

  // ---- 2d: Programmatic migration path -----------------------------------

  it('2d: migration auto-creates crons.json + marker from config.json crons array', () => {
    const agent = 'legacy-user-agent';

    // Set up: fake agent dir with config.json containing legacy crons (config.json format)
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });

    const legacyCrons = [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md and follow its instructions.' },
      { name: 'daily-sync', type: 'recurring', interval: '24h', prompt: 'Run the full daily workflow.' },
    ];

    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({
      agent_name: agent,
      enabled: true,
      crons: legacyCrons,
    }), 'utf-8');

    // Before migration: crons.json and marker should not exist
    expect(existsSync(cronsJsonPath(agent))).toBe(false);
    expect(existsSync(markerPath(agent))).toBe(false);

    // Run migration (what daemon does on boot — automatic per the guide)
    const result = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(2);
    expect(result.cronsSkipped).toHaveLength(0);

    // After: crons.json must exist with both crons
    expect(existsSync(cronsJsonPath(agent))).toBe(true);
    const diskData = readCronsJson(agent);
    expect(diskData).not.toBeNull();
    expect(diskData!.crons).toHaveLength(2);

    const names = diskData!.crons.map(c => c.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('daily-sync');

    // Marker must exist
    expect(existsSync(markerPath(agent))).toBe(true);
    expect(isMigrated(tmpRoot, agent)).toBe(true);
  });

  it('2e: no data loss — every config.json cron appears in crons.json', () => {
    const agent = 'no-loss-agent';
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });

    const cronEntries = [
      { name: 'alpha', type: 'recurring', interval: '1h',  prompt: 'Alpha prompt.' },
      { name: 'beta',  type: 'recurring', interval: '2h',  prompt: 'Beta prompt.' },
      { name: 'gamma', type: 'recurring', cron: '0 9 * * 1-5', prompt: 'Gamma prompt.' },
    ];

    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({ crons: cronEntries }), 'utf-8');

    migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });

    const migrated = readCrons(agent);
    expect(migrated).toHaveLength(3);

    // Every original name present
    const migratedNames = new Set(migrated.map(c => c.name));
    for (const entry of cronEntries) {
      expect(migratedNames.has(entry.name), `cron "${entry.name}" must not be lost`).toBe(true);
    }

    // Schedules preserved
    const alphaEntry = migrated.find(c => c.name === 'alpha')!;
    expect(alphaEntry.schedule).toBe('1h');

    const gammaEntry = migrated.find(c => c.name === 'gamma')!;
    expect(gammaEntry.schedule).toBe('0 9 * * 1-5');
  });

  it('2f: migration is idempotent — second run skips (marker present)', () => {
    const agent = 'idempotent-agent';
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });

    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({
      crons: [{ name: 'hb', type: 'recurring', interval: '1h', prompt: 'Heartbeat.' }],
    }), 'utf-8');

    // First run
    const r1 = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });
    expect(r1.status).toBe('migrated');

    // Second run — must be skipped (doc says marker prevents re-runs)
    const r2 = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });
    expect(r2.status).toBe('skipped-already-migrated');

    // crons.json unchanged (still has exactly 1 cron)
    expect(readCrons(agent)).toHaveLength(1);
  });

  it('2g: --force flag bypasses marker (doc prescribes this for manual re-run)', () => {
    const agent = 'force-agent';
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });

    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({
      crons: [{ name: 'hb', type: 'recurring', interval: '1h', prompt: 'Heartbeat.' }],
    }), 'utf-8');

    // First migration
    migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });
    expect(isMigrated(tmpRoot, agent)).toBe(true);

    // Force re-run — marker should be cleared and re-created
    const forceResult = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { force: true, log: () => {} });
    expect(forceResult.status).toBe('migrated');
    // Marker must exist again after force
    expect(isMigrated(tmpRoot, agent)).toBe(true);
  });

  it('2h: migration message format is clear + non-scary (no "ERROR" or "DANGER" in normal path)', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);

    // The "What You Need to Do" section should be brief and reassuring
    const whatSection = doc.split('## What You Need to Do')[1] ?? '';
    expect(whatSection.slice(0, 200)).toMatch(/Nothing|automatic/i);

    // Doc must not open with alarming language in the What You Need to Do section
    const alarmingPattern = /DANGER|BREAKING CHANGE|YOU MUST MANUALLY/i;
    expect(alarmingPattern.test(whatSection.slice(0, 300))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Operator adds cron via skill docs (cron-management/SKILL.md)
// ---------------------------------------------------------------------------

describe('Scenario 3: Operator cron CRUD via cron-management/SKILL.md', () => {
  const agent = 'operator-agent';

  // ---- 3a: Doc content assertions ----------------------------------------

  it('3a: SKILL.md exists and prescribes bus add-cron workflow', () => {
    const doc = readDoc(SKILL_MD);

    // Must document add-cron command
    expect(doc).toContain('cortextos bus add-cron');
    // Must show interval form
    expect(doc).toMatch(/bus add-cron.*heartbeat.*[0-9]+h/);
    // Must show cron expression form
    expect(doc).toMatch(/bus add-cron.*"0 [0-9]+ \*/);
    // Must document list-crons
    expect(doc).toContain('cortextos bus list-crons');
    // Must document remove-cron
    expect(doc).toContain('cortextos bus remove-cron');
    // Must document update-cron
    expect(doc).toContain('cortextos bus update-cron');
    // Must document test-cron-fire
    expect(doc).toContain('cortextos bus test-cron-fire');
    // Must document get-cron-log
    expect(doc).toContain('cortextos bus get-cron-log');
    // Must have a troubleshooting section
    expect(doc).toContain('Troubleshooting');
  });

  it('3b: skill doc examples are syntactically correct (interval + cron expression parseable)', () => {
    const doc = readDoc(SKILL_MD);

    // Extract lines that look like bus add-cron invocations
    const addCronLines = doc.split('\n').filter(l => /cortextos bus add-cron/.test(l));
    expect(addCronLines.length, 'Skill doc must have multiple add-cron examples').toBeGreaterThan(2);

    // Every example should have an agent placeholder + a name + a schedule
    for (const line of addCronLines) {
      // Accept either $CTX_AGENT_NAME or a concrete agent name
      expect(line).toMatch(/\$CTX_AGENT_NAME|<agent>|\w+-agent/);
    }
  });

  // ---- 3c: Programmatic CRUD sequence -------------------------------------

  it('3c: add-cron → list shows it → test-cron-fire → get-cron-log → remove-cron removes it', async () => {
    mkdirSync(join(tmpRoot, CRONS_DIR, agent), { recursive: true });

    // ADD
    addCron(agent, {
      name: 'heartbeat',
      schedule: '6h',
      prompt: 'Read HEARTBEAT.md and follow its instructions.',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    // LIST — doc says list-crons shows all crons for agent
    const listed = readCrons(agent);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('heartbeat');

    // TEST-FIRE — simulate what the CLI does internally (direct appendExecutionLog)
    // The bus CLI command calls appendExecutionLog after injection; we validate the
    // same disk path the doc describes via get-cron-log
    const firedEntry: CronExecutionLogEntry = {
      ts: new Date().toISOString(),
      cron: 'heartbeat',
      status: 'fired',
      attempt: 1,
      duration_ms: 12,
      error: null,
    };
    appendExecutionLog(agent, firedEntry);

    // GET-CRON-LOG — doc says this shows execution history per-cron
    const log = getExecutionLog(agent, 'heartbeat', 10);
    expect(log).toHaveLength(1);
    expect(log[0].cron).toBe('heartbeat');
    expect(log[0].status).toBe('fired');
    expect(log[0].error).toBeNull();

    // REMOVE
    const removed = removeCron(agent, 'heartbeat');
    expect(removed).toBe(true);

    // LIST again — must be empty
    const afterRemove = readCrons(agent);
    expect(afterRemove).toHaveLength(0);
    // getCronByName returns undefined
    expect(getCronByName(agent, 'heartbeat')).toBeUndefined();
  });

  it('3d: update-cron changes schedule in crons.json (doc shows --interval + --prompt examples)', () => {
    mkdirSync(join(tmpRoot, CRONS_DIR, agent + '-update'), { recursive: true });
    const a = agent + '-update';

    addCron(a, {
      name: 'monitor',
      schedule: '1h',
      prompt: 'Check system health.',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    // Doc example: update-cron $CTX_AGENT_NAME heartbeat --interval 4h
    updateCron(a, 'monitor', { schedule: '4h' });

    const updated = getCronByName(a, 'monitor');
    expect(updated).toBeDefined();
    expect(updated!.schedule).toBe('4h');
  });

  it('3e: update-cron --enabled false disables cron (doc shows pause/resume)', () => {
    const a = agent + '-disable';
    mkdirSync(join(tmpRoot, CRONS_DIR, a), { recursive: true });

    addCron(a, {
      name: 'noisy-cron',
      schedule: '15m',
      prompt: 'Do noisy work.',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    // Disable
    updateCron(a, 'noisy-cron', { enabled: false });
    expect(getCronByName(a, 'noisy-cron')!.enabled).toBe(false);

    // Re-enable
    updateCron(a, 'noisy-cron', { enabled: true });
    expect(getCronByName(a, 'noisy-cron')!.enabled).toBe(true);
  });

  it('3f: scheduler does not fire disabled crons (daemon-managed check)', async () => {
    const a = agent + '-sched';
    mkdirSync(join(tmpRoot, CRONS_DIR, a), { recursive: true });

    addCron(a, {
      name: 'disabled-cron',
      schedule: '1m',
      prompt: 'Should not fire.',
      enabled: false,
      created_at: new Date().toISOString(),
    });

    let fired = false;
    const scheduler = new CronScheduler({
      agentName: a,
      onFire: async () => { fired = true; },
      logger: () => {},
    });

    vi.useFakeTimers();
    try {
      scheduler.start();

      // getNextFireTimes() should return empty for disabled crons
      const times = scheduler.getNextFireTimes();
      expect(times).toHaveLength(0);

      // Advance 5 min — disabled cron should never fire
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(fired).toBe(false);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Support troubleshooting a missing cron
// ---------------------------------------------------------------------------

describe('Scenario 4: Support troubleshooting missing crons', () => {
  // ---- 4a: Doc coverage assertions ----------------------------------------

  it('4a: CRONS_MIGRATION_GUIDE.md Troubleshooting section covers required failure modes', () => {
    const doc = readDoc(CRONS_MIGRATION_GUIDE);

    const troubleshootingSection = doc.split('## Troubleshooting')[1] ?? '';
    expect(troubleshootingSection.length, 'Troubleshooting section must be non-empty').toBeGreaterThan(100);

    // Must cover: migration did not run
    expect(troubleshootingSection).toMatch(/[Mm]igration did not run|No marker/i);

    // Must cover: cron not firing
    expect(troubleshootingSection).toMatch(/[Cc]ron not firing/i);

    // Must prescribe list-crons as first diagnostic
    expect(troubleshootingSection).toContain('list-crons');

    // Must prescribe get-cron-log for history
    expect(troubleshootingSection).toContain('get-cron-log');

    // Must cover: manual re-run path
    expect(troubleshootingSection).toContain('cortextos bus migrate-crons');
  });

  it('4b: cron-management/SKILL.md Troubleshooting covers cron-not-firing + just-added-cron', () => {
    const doc = readDoc(SKILL_MD);

    const troubleshootingSection = doc.split('## Troubleshooting')[1] ?? '';
    expect(troubleshootingSection.length, 'Skill Troubleshooting section must be non-empty').toBeGreaterThan(100);

    // Must mention list-crons as step 1 for cron-not-firing
    expect(troubleshootingSection).toMatch(/list.crons/i);

    // Must mention get-cron-log for history check
    expect(troubleshootingSection).toMatch(/get.cron.log/i);

    // Must cover stale daemon / daemon not reloaded
    expect(troubleshootingSection).toMatch(/daemon.*reload|reload|migrate-crons.*force/i);

    // Must cover disabled cron check
    expect(troubleshootingSection).toMatch(/disabled|enabled false/i);
  });

  // ---- 4c: Programmatic troubleshooting flows ----------------------------

  it('4c: list-crons returns empty when crons.json is absent (migration never ran)', () => {
    const agent = 'unmigrated-agent';
    // No migration ran — agent state dir doesn't even exist yet

    // list-crons path: readCrons returns [] when file missing
    const crons = readCrons(agent);
    expect(crons).toHaveLength(0);

    // crons.json does not exist
    expect(existsSync(cronsJsonPath(agent))).toBe(false);

    // Marker does not exist
    expect(existsSync(markerPath(agent))).toBe(false);
    expect(isMigrated(tmpRoot, agent)).toBe(false);
  });

  it('4d: manual migrate-crons fixes the missing cron (doc step 2 for "migration did not run")', () => {
    const agent = 'unmigrated-agent-d';

    // Set up legacy config.json with crons
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });
    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({
      crons: [
        { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md.' },
      ],
    }), 'utf-8');

    // Before: missing
    expect(readCrons(agent)).toHaveLength(0);
    expect(isMigrated(tmpRoot, agent)).toBe(false);

    // Support step: run manual migrate-crons
    const result = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });
    expect(result.status).toBe('migrated');

    // After: cron is now present
    expect(readCrons(agent)).toHaveLength(1);
    expect(isMigrated(tmpRoot, agent)).toBe(true);
  });

  it('4e: stale .migrated marker without crons.json — force re-migration recovers crons', () => {
    const agent = 'stale-marker-agent';

    // Simulate: marker exists but crons.json was deleted (stale marker scenario)
    const stateDir = join(tmpRoot, CRONS_DIR, agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, MARKER_FILE), '', 'utf-8'); // stale marker only

    // crons.json is missing
    expect(existsSync(cronsJsonPath(agent))).toBe(false);
    // But isMigrated returns true (stale marker fools it)
    expect(isMigrated(tmpRoot, agent)).toBe(true);

    // Without force: migration skipped (stale marker blocks it)
    const agentDir = join(tmpRoot, 'orgs', 'lifeos', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });
    const configJsonPath = join(agentDir, 'config.json');
    writeFileSync(configJsonPath, JSON.stringify({
      crons: [{ name: 'hb', type: 'recurring', interval: '1h', prompt: 'Heartbeat.' }],
    }), 'utf-8');

    const r1 = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { log: () => {} });
    expect(r1.status).toBe('skipped-already-migrated');

    // With --force: marker removed, migration runs, crons.json created
    const r2 = migrateCronsForAgent(agent, configJsonPath, tmpRoot, { force: true, log: () => {} });
    expect(r2.status).toBe('migrated');
    expect(existsSync(cronsJsonPath(agent))).toBe(true);
    expect(readCrons(agent)).toHaveLength(1);
  });

  it('4f: malformed crons.json — readCrons returns [] gracefully (no crash)', () => {
    const agent = 'malformed-agent';

    // Create malformed crons.json
    const stateDir = join(tmpRoot, CRONS_DIR, agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cronsJsonPath(agent), '{ "crons": [INVALID JSON }', 'utf-8');

    // list-crons path: readCrons must return [] without throwing
    let crons: CronDefinition[] = [];
    expect(() => {
      crons = readCrons(agent);
    }).not.toThrow();
    expect(crons).toHaveLength(0);
  });

  it('4g: get-cron-log returns [] when no log exists — no crash', () => {
    const agent = 'no-log-agent';

    const log = getExecutionLog(agent, 'heartbeat', 10);
    expect(log).toHaveLength(0);
  });

  it('4h: scheduler with empty crons.json registers 0 crons — daemon not running shows no next_fire_at', () => {
    const agent = 'empty-crons-agent';
    mkdirSync(join(tmpRoot, CRONS_DIR, agent), { recursive: true });

    // Empty crons.json (migration ran but no crons defined)
    writeFileSync(cronsJsonPath(agent), JSON.stringify({ updated_at: new Date().toISOString(), crons: [] }), 'utf-8');

    const scheduler = new CronScheduler({
      agentName: agent,
      onFire: async () => {},
      logger: () => {},
    });

    vi.useFakeTimers();
    try {
      scheduler.start();
      const times = scheduler.getNextFireTimes();
      // No crons → no next fire times
      expect(times).toHaveLength(0);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('4i: troubleshooting doc coverage analysis — at least 4 of 4 failure modes documented', () => {
    const migDoc   = readDoc(CRONS_MIGRATION_GUIDE);
    const skillDoc = readDoc(SKILL_MD);
    const combined = migDoc + '\n' + skillDoc;

    const failureModes: Array<{ label: string; pattern: RegExp }> = [
      { label: 'missing crons.json', pattern: /No marker|[Mm]igration did not run|crons\.json.*missing|no crons\.json/i },
      { label: 'stale .migrated marker', pattern: /\.crons-migrated|marker.*stale|--force|force.*marker/i },
      { label: 'daemon not running / reload needed', pattern: /daemon.*reload|migrate-crons.*force|restart.*agent/i },
      { label: 'malformed / empty crons.json', pattern: /malformed|corrupt|empty.*crons\.json|no crons array/i },
    ];

    let covered = 0;
    const gaps: string[] = [];
    for (const { label, pattern } of failureModes) {
      if (pattern.test(combined)) {
        covered++;
      } else {
        gaps.push(label);
      }
    }

    // Require all 4 failure modes covered
    expect(covered, `Docs must cover all failure modes. Gaps: ${gaps.join(', ')}`).toBe(4);
  });
});
