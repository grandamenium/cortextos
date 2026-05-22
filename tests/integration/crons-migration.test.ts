/**
 * tests/integration/crons-migration.test.ts — Subtask 2.2 Integration Tests
 *
 * Covers all acceptance scenarios specified in EXTERNAL_CRONS_PLAN.md § 2.2:
 *
 *  1. Migrate clean agent (config has 4 crons → crons.json has same 4)
 *  2. Idempotency: migrate twice → no duplicates, second run is no-op (marker present)
 *  3. Migrate with --force → re-runs even with marker, overwrites crons.json
 *  4. type:"once" with future fire_at → skipped with explicit log (not representable in CronDefinition)
 *  5. type:"once" with past fire_at → skipped with log
 *  6. Missing `type` field → defaults to recurring
 *  7. Multiple agents migrated via migrateAllAgents()
 *  8. Missing config.json → no-op result, no crash, empty crons.json + marker created
 *  9. Config.json with no crons array → empty crons.json + marker created
 * 10. Field mapping correctness — each migrated CronDefinition matches readCrons() output
 *
 * All tests use temp directories only — no real config.json or crons.json files
 * in the repository are touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
// Types used directly in tests
// ---------------------------------------------------------------------------
import type { CronDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

// ---------------------------------------------------------------------------
// Per-test environment wiring
//
// We reset modules per test so that CTX_ROOT env changes are picked up by
// the crons.ts module (which reads process.env.CTX_ROOT at call time —
// but the join() is inside the function, so it's fine either way).
// ---------------------------------------------------------------------------

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let migrateAllAgents: typeof import('../../src/daemon/cron-migration.js').migrateAllAgents;
let isMigrated: typeof import('../../src/daemon/cron-migration.js').isMigrated;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;

async function reloadModules() {
  vi.resetModules();
  const migModule = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migModule.migrateCronsForAgent;
  migrateAllAgents = migModule.migrateAllAgents;
  isMigrated = migModule.isMigrated;
  const cronsModule = await import('../../src/bus/crons.js');
  readCrons = cronsModule.readCrons;
}

/**
 * Write a config.json to the agent dir with the given crons array.
 */
function writeConfigJson(agentDir: string, crons: unknown[]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'test', enabled: true, crons }),
    'utf-8',
  );
}

/**
 * Read the raw crons.json envelope from disk (bypassing readCrons abstraction).
 */
function rawCronsJson(ctxRoot: string, agentName: string): { updated_at: string; crons: CronDefinition[] } | null {
  const { existsSync: fsExists, readFileSync: fsRead } = require('fs') as typeof import('fs');
  const path = join(ctxRoot, CRONS_DIR, agentName, CRONS_FILE);
  if (!fsExists(path)) return null;
  return JSON.parse(fsRead(path, 'utf-8'));
}

/**
 * Check if marker file exists.
 */
function markerExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, CRONS_DIR, agentName, MARKER_FILE));
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'crons-migration-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'crons-migration-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test 1: Migrate clean agent with 4 recurring crons
// ---------------------------------------------------------------------------

describe('migrateCronsForAgent', () => {
  it('migrates all 4 recurring crons from config.json', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'alpha');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md and run it.' },
      { name: 'daily-review', interval: '24h', prompt: 'Review the day.' },
      { name: 'pr-monitor', type: 'recurring', interval: '6h', prompt: 'Scan PRs.' },
      { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly report.' },
    ]);

    const result = migrateCronsForAgent('alpha', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(4);
    expect(result.cronsSkipped).toHaveLength(0);

    const crons = readCrons('alpha');
    expect(crons).toHaveLength(4);

    // Marker must exist
    expect(markerExists(tmpCtxRoot, 'alpha')).toBe(true);
    expect(isMigrated(tmpCtxRoot, 'alpha')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Idempotency — second run is a no-op
  // ---------------------------------------------------------------------------

  it('is idempotent: second migration run is skipped (marker present, no duplicates)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'alpha');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First run
    const first = migrateCronsForAgent('alpha', configPath, tmpCtxRoot);
    expect(first.status).toBe('migrated');
    expect(first.cronsMigrated).toBe(1);

    // Second run — must be a no-op
    const second = migrateCronsForAgent('alpha', configPath, tmpCtxRoot);
    expect(second.status).toBe('skipped-already-migrated');

    // Still exactly 1 cron — no duplication
    const crons = readCrons('alpha');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');

    // Marker still exists
    expect(markerExists(tmpCtxRoot, 'alpha')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: --force flag re-runs migration
  // ---------------------------------------------------------------------------

  it('re-runs migration when force: true (deletes marker first)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'beta');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First run
    migrateCronsForAgent('beta', configPath, tmpCtxRoot);
    expect(isMigrated(tmpCtxRoot, 'beta')).toBe(true);

    // Modify config — add a second cron — then force re-run
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'daily', interval: '24h', prompt: 'Daily check.' },
    ]);

    const forced = migrateCronsForAgent('beta', configPath, tmpCtxRoot, { force: true });
    expect(forced.status).toBe('migrated');
    expect(forced.cronsMigrated).toBe(2);

    const crons = readCrons('beta');
    expect(crons).toHaveLength(2);
    expect(crons.map(c => c.name)).toContain('daily');

    // Marker exists again after re-migration
    expect(isMigrated(tmpCtxRoot, 'beta')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 4: type:"once" with future fire_at → skipped with log
  // ---------------------------------------------------------------------------

  it('skips type:"once" with future fire_at (not representable in CronDefinition)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'gamma');
    const futureTs = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    writeConfigJson(agentDir, [
      { name: 'one-shot', type: 'once', fire_at: futureTs, prompt: 'Do something once.' },
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const logs: string[] = [];
    const result = migrateCronsForAgent('gamma', configPath, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    expect(result.cronsSkipped).toContain('one-shot');

    // one-shot must not appear in crons.json
    const crons = readCrons('gamma');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');

    // Log must mention the skip reason
    const skipLog = logs.find(l => l.includes('one-shot') && l.includes('skip'));
    expect(skipLog).toBeTruthy();

    expect(markerExists(tmpCtxRoot, 'gamma')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 5: type:"once" with past fire_at → skipped with log
  // ---------------------------------------------------------------------------

  it('skips type:"once" with past fire_at (already expired)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'delta');
    const pastTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeConfigJson(agentDir, [
      { name: 'past-shot', type: 'once', fire_at: pastTs, prompt: 'This already ran.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const logs: string[] = [];
    const result = migrateCronsForAgent('delta', configPath, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(0);
    expect(result.cronsSkipped).toContain('past-shot');

    const crons = readCrons('delta');
    expect(crons).toHaveLength(0);

    const skipLog = logs.find(l => l.includes('past-shot'));
    expect(skipLog).toBeTruthy();

    expect(markerExists(tmpCtxRoot, 'delta')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Missing `type` field → defaults to recurring
  // ---------------------------------------------------------------------------

  it('treats missing type field as "recurring"', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'epsilon');
    writeConfigJson(agentDir, [
      // No `type` field — should default to recurring
      { name: 'implicit-recurring', interval: '12h', prompt: 'Do the thing.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('epsilon', configPath, tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    expect(result.cronsSkipped).toHaveLength(0);

    const crons = readCrons('epsilon');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('implicit-recurring');
    expect(crons[0].schedule).toBe('12h');
    expect(crons[0].enabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Missing config.json → no-op, no crash, marker created
  // ---------------------------------------------------------------------------

  it('handles missing config.json gracefully: no crash, empty crons.json + marker', () => {
    const configPath = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'noconfig', 'config.json');
    // Do NOT write config.json

    const result = migrateCronsForAgent('noconfig', configPath, tmpCtxRoot);

    expect(result.status).toBe('no-config');
    expect(result.cronsMigrated).toBeUndefined();

    // crons.json should exist (empty envelope)
    const raw = rawCronsJson(tmpCtxRoot, 'noconfig');
    expect(raw).not.toBeNull();
    expect(raw!.crons).toHaveLength(0);

    // Marker must exist so we don't retry every boot
    expect(markerExists(tmpCtxRoot, 'noconfig')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Config.json with no crons array → empty crons.json + marker
  // ---------------------------------------------------------------------------

  it('handles config.json with no crons array: writes empty crons.json + marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'nocrons');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'nocrons', enabled: true }),
      'utf-8',
    );

    const result = migrateCronsForAgent('nocrons', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('no-crons');

    const crons = readCrons('nocrons');
    expect(crons).toHaveLength(0);

    expect(markerExists(tmpCtxRoot, 'nocrons')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Empty crons array → empty crons.json + marker
  // ---------------------------------------------------------------------------

  it('handles config.json with empty crons array: writes empty crons.json + marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'emptycrons');
    writeConfigJson(agentDir, []);

    const result = migrateCronsForAgent('emptycrons', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('no-crons');

    const crons = readCrons('emptycrons');
    expect(crons).toHaveLength(0);

    expect(markerExists(tmpCtxRoot, 'emptycrons')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 10: Field mapping correctness
  // ---------------------------------------------------------------------------

  it('maps all fields correctly: name, schedule (from interval), prompt, enabled, metadata', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'zeta');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('zeta', configPath, tmpCtxRoot);

    const crons = readCrons('zeta');
    expect(crons).toHaveLength(1);

    const c = crons[0];
    expect(c.name).toBe('heartbeat');
    expect(c.schedule).toBe('6h');           // interval → schedule
    expect(c.prompt).toBe('Read HEARTBEAT.md.');
    expect(c.enabled).toBe(true);
    expect(typeof c.created_at).toBe('string');
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    // Metadata should record the migration origin
    expect(c.metadata?.migrated_from_config).toBe(true);
    expect(c.metadata?.original_type).toBe('recurring');
  });

  it('maps cron expression field correctly (cron → schedule)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'eta');
    writeConfigJson(agentDir, [
      { name: 'morning', type: 'recurring', cron: '0 13 * * *', prompt: 'Morning briefing.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('eta', configPath, tmpCtxRoot);

    const crons = readCrons('eta');
    expect(crons).toHaveLength(1);
    expect(crons[0].schedule).toBe('0 13 * * *');
    expect(crons[0].name).toBe('morning');
  });

  it('cron expression takes precedence over interval when both are present', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'theta');
    writeConfigJson(agentDir, [
      { name: 'both', cron: '0 8 * * *', interval: '24h', prompt: 'Cron wins over interval.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('theta', configPath, tmpCtxRoot);

    const crons = readCrons('theta');
    expect(crons).toHaveLength(1);
    // cron field takes precedence (mirrors convertEntry logic)
    expect(crons[0].schedule).toBe('0 8 * * *');
  });
});

// ---------------------------------------------------------------------------
// Test 11: Multiple agents migrated via migrateAllAgents()
// ---------------------------------------------------------------------------

describe('migrateAllAgents', () => {
  it('migrates all agents in framework across multiple orgs', () => {
    // Create 3 agents in 2 orgs
    const agents = [
      { org: 'lifeos', name: 'boris', crons: [
        { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Heartbeat.' },
        { name: 'daily', interval: '24h', prompt: 'Daily.' },
      ]},
      { org: 'lifeos', name: 'paul', crons: [
        { name: 'briefing', interval: '12h', prompt: 'Briefing.' },
      ]},
      { org: 'cointally', name: 'becky', crons: [
        { name: 'usage', interval: '1h', prompt: 'Usage check.' },
        { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly.' },
      ]},
    ];

    for (const { org, name, crons } of agents) {
      const agentDir = join(tmpFrameworkRoot, 'orgs', org, 'agents', name);
      writeConfigJson(agentDir, crons);
    }

    const logs: string[] = [];
    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(summary.processed).toBe(3);
    expect(summary.totalCronsMigrated).toBe(5);
    expect(summary.results).toHaveLength(3);

    // All agents should be marked as migrated
    for (const { name } of agents) {
      expect(isMigrated(tmpCtxRoot, name)).toBe(true);
    }

    // Verify each agent's crons.json is correct
    expect(readCrons('boris')).toHaveLength(2);
    expect(readCrons('paul')).toHaveLength(1);
    expect(readCrons('becky')).toHaveLength(2);
  });

  it('skips already-migrated agents and reports correct counts', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'iota');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // Pre-migrate iota manually
    migrateCronsForAgent('iota', configPath, tmpCtxRoot);
    expect(isMigrated(tmpCtxRoot, 'iota')).toBe(true);

    // Run all-agents migration
    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      log: () => {},
    });

    // iota should be in results as 'skipped-already-migrated'
    const iotaResult = summary.results.find(r => r.agentName === 'iota');
    expect(iotaResult?.status).toBe('skipped-already-migrated');

    // No duplicate crons
    expect(readCrons('iota')).toHaveLength(1);
  });

  it('force flag re-migrates all agents', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'kappa');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First migration
    migrateCronsForAgent('kappa', configPath, tmpCtxRoot);

    // Update config (add cron), then force-migrate all
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
      { name: 'extra', interval: '12h', prompt: 'Extra.' },
    ]);

    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    const kappaResult = summary.results.find(r => r.agentName === 'kappa');
    expect(kappaResult?.status).toBe('migrated');
    expect(kappaResult?.cronsMigrated).toBe(2);

    expect(readCrons('kappa')).toHaveLength(2);
  });

  it('handles missing orgs directory gracefully (no crash)', () => {
    const emptyFwRoot = mkdtempSync(join(tmpdir(), 'crons-migration-empty-'));
    try {
      const summary = migrateAllAgents(emptyFwRoot, tmpCtxRoot, { log: () => {} });
      expect(summary.processed).toBe(0);
      expect(summary.totalCronsMigrated).toBe(0);
      expect(summary.results).toHaveLength(0);
    } finally {
      try { rmSync(emptyFwRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 12: Disabled crons are migrated as enabled:false
// ---------------------------------------------------------------------------

describe('disabled cron handling', () => {
  it('migrates type:"disabled" cron with enabled:false', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda');
    writeConfigJson(agentDir, [
      { name: 'paused', type: 'disabled', interval: '6h', prompt: 'This is paused.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('lambda', configPath, tmpCtxRoot);
    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);

    const crons = readCrons('lambda');
    expect(crons).toHaveLength(1);
    expect(crons[0].enabled).toBe(false);
    expect(crons[0].name).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// Test 13: readCrons round-trip — verify migrated definitions survive a disk round-trip
// ---------------------------------------------------------------------------

describe('disk round-trip via readCrons()', () => {
  it('migrated crons survive JSON serialization and are readable by readCrons()', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'mu');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('mu', configPath, tmpCtxRoot);

    // Read back via readCrons() — not the raw file
    const crons = readCrons('mu');
    expect(crons).toHaveLength(2);

    const hb = crons.find(c => c.name === 'heartbeat');
    const wk = crons.find(c => c.name === 'weekly');

    expect(hb).toBeDefined();
    expect(hb!.schedule).toBe('6h');
    expect(hb!.prompt).toBe('Run heartbeat.');
    expect(hb!.enabled).toBe(true);

    expect(wk).toBeDefined();
    expect(wk!.schedule).toBe('0 16 * * 1');
    expect(wk!.prompt).toBe('Weekly.');
    expect(wk!.enabled).toBe(true);
  });
});
