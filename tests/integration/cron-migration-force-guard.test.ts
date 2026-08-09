/**
 * cron-migration-force-guard.test.ts
 *
 * REGRESSION GUARD for the `migrate-crons --force` wipe-to-empty class.
 *
 * ## The defect
 *
 * `runMigrationCore` deletes the idempotency marker BEFORE the `isMigrated` gate,
 * so `--force` re-runs the whole migration body against a crons.json that is, by
 * now, the AUTHORITATIVE daemon-managed store — not an empty bootstrap target.
 * `readCrons` is never called on that path, so a merge is impossible by construction.
 *
 * THREE DIFFERENT CAUSES CONVERGE ON ONE DESTRUCTIVE EFFECT — `writeCrons(agent, [])`:
 *
 *   1. config.json MISSING      -> writeCrons([]) + marker
 *   2. config.json UNPARSEABLE  -> writeCrons([]) + marker
 *   3. config.json has NO crons -> writeCrons([]) + marker
 *
 * Cause (3) is the steady state for every already-migrated agent in the fleet: the
 * `crons` array in config.json is a spent one-time seed and is routinely absent.
 * THE SAFEST-LOOKING CONFIG IS THE MOST DESTRUCTIVE INPUT.
 *
 * ## The contract this file pins
 *
 * - MISSING / NO-CRONS: never clobber a NON-EMPTY crons.json. Preserve it, drop the
 *   marker so we do not loop, and report `preserved-existing-crons`.
 * - UNPARSEABLE: ABORT, not merely gate. Write NOTHING — not the crons, not the
 *   marker. Writing an empty store on an input we failed to read destroys data on
 *   the strength of a value we never established; writing the marker as well would
 *   permanently foreclose migrating the real content once the file is repaired.
 * - The legitimate bootstrap path (empty/absent destination) MUST still write the
 *   empty store and the marker. A guard that breaks first-run migration is not a fix.
 *
 * Each arm carries a NEGATIVE CONTROL: the same call against an EMPTY destination,
 * which must still take the original path. A guard that preserves unconditionally
 * would pass the positive arms alone, so the positive arms are not controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

const AGENT = 'guarded';

let tmpCtxRoot: string;
let tmpAgentDir: string;
const originalCtxRoot = process.env.CTX_ROOT;

let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let isMigrated: typeof import('../../src/daemon/cron-migration.js').isMigrated;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let writeCrons: typeof import('../../src/bus/crons.js').writeCrons;

async function reloadModules(): Promise<void> {
  vi.resetModules();
  const migMod = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migMod.migrateCronsForAgent;
  isMigrated = migMod.isMigrated;
  const cronsMod = await import('../../src/bus/crons.js');
  readCrons = cronsMod.readCrons;
  writeCrons = cronsMod.writeCrons;
}

function markerPath(): string {
  return join(tmpCtxRoot, CRONS_DIR, AGENT, MARKER_FILE);
}

function cronsPath(): string {
  return join(tmpCtxRoot, CRONS_DIR, AGENT, CRONS_FILE);
}

/**
 * Seed a LIVE, daemon-managed crons.json — i.e. the state every already-migrated
 * agent is in. Deliberately holds a cron that exists in NO config.json, which is
 * exactly the content a re-migration cannot reconstruct.
 */
function seedLiveCrons(): void {
  writeCrons(AGENT, [
    {
      name: 'daemon-created-watch',
      prompt: 'Created by the daemon after migration. Exists in no config.json.',
      schedule: '12,42 * * * *',
      enabled: true,
      created_at: '2026-08-01T00:00:00.000Z',
    },
    {
      name: 'heartbeat',
      prompt: 'Run the heartbeat workflow.',
      schedule: '8h',
      enabled: true,
      created_at: '2026-08-01T00:00:00.000Z',
    },
  ]);
  // Migration has already happened for this agent — that is the whole premise.
  mkdirSync(join(tmpCtxRoot, CRONS_DIR, AGENT), { recursive: true });
  writeFileSync(markerPath(), '', 'utf-8');
}

function writeConfig(contents: string): string {
  const p = join(tmpAgentDir, 'config.json');
  writeFileSync(p, contents, 'utf-8');
  return p;
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'force-guard-ctx-'));
  tmpAgentDir = mkdtempSync(join(tmpdir(), 'force-guard-agent-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  rmSync(tmpCtxRoot, { recursive: true, force: true });
  rmSync(tmpAgentDir, { recursive: true, force: true });
});

describe('migrate-crons --force must not wipe a live crons.json', () => {
  // -------------------------------------------------------------------------
  // Cause 1 — config.json MISSING
  // -------------------------------------------------------------------------
  it('CAUSE 1 (missing config.json): preserves a populated crons.json', () => {
    seedLiveCrons();
    expect(readCrons(AGENT)).toHaveLength(2);

    const missingConfig = join(tmpAgentDir, 'config.json'); // never created
    expect(existsSync(missingConfig)).toBe(false);

    const result = migrateCronsForAgent(AGENT, missingConfig, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    const after = readCrons(AGENT);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.name).sort()).toEqual(['daemon-created-watch', 'heartbeat']);
    expect(result.status).toBe('preserved-existing-crons');
    // Marker restored so the daemon does not loop on every boot.
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(true);
  });

  it('CAUSE 1 NEGATIVE CONTROL (missing config.json, EMPTY destination): still bootstraps', () => {
    const missingConfig = join(tmpAgentDir, 'config.json');
    const result = migrateCronsForAgent(AGENT, missingConfig, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(result.status).toBe('no-config');
    expect(readCrons(AGENT)).toHaveLength(0);
    expect(existsSync(cronsPath())).toBe(true);
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cause 2 — config.json UNPARSEABLE. ABORT, not gate.
  // -------------------------------------------------------------------------
  it('CAUSE 2 (unparseable config.json): ABORTS — writes neither crons nor marker', () => {
    seedLiveCrons();
    const configPath = writeConfig('{ "crons": [ this is not json');

    const logs: string[] = [];
    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: (m) => logs.push(m),
    });

    expect(result.status).toBe('aborted-unparseable-config');
    const after = readCrons(AGENT);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.name).sort()).toEqual(['daemon-created-watch', 'heartbeat']);
    // The marker must NOT be re-written: a repaired config.json has to be able to
    // migrate later. Writing it here would foreclose that permanently.
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(false);
    expect(logs.join('\n')).toMatch(/ABORT/i);
  });

  it('CAUSE 2 (unparseable config.json, EMPTY destination): STILL aborts — never writes on unread input', () => {
    // Abort is unconditional. It is not a function of what the destination holds:
    // we failed to read the source, so we have established nothing to act on.
    const configPath = writeConfig('}{ broken');

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(result.status).toBe('aborted-unparseable-config');
    expect(existsSync(cronsPath())).toBe(false);
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cause 3 — config.json present, NO crons array. The fleet steady state.
  // -------------------------------------------------------------------------
  it('CAUSE 3 (config.json with no crons array): preserves a populated crons.json', () => {
    seedLiveCrons();
    const configPath = writeConfig(JSON.stringify({ name: AGENT, enabled: true }));

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    const after = readCrons(AGENT);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.name).sort()).toEqual(['daemon-created-watch', 'heartbeat']);
    expect(result.status).toBe('preserved-existing-crons');
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(true);
  });

  it('CAUSE 3 variant (crons present but EMPTY array): preserves a populated crons.json', () => {
    seedLiveCrons();
    const configPath = writeConfig(JSON.stringify({ name: AGENT, crons: [] }));

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(readCrons(AGENT)).toHaveLength(2);
    expect(result.status).toBe('preserved-existing-crons');
  });

  it('CAUSE 3 NEGATIVE CONTROL (no crons array, EMPTY destination): still bootstraps', () => {
    const configPath = writeConfig(JSON.stringify({ name: AGENT, enabled: true }));

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(result.status).toBe('no-crons');
    expect(readCrons(AGENT)).toHaveLength(0);
    expect(existsSync(cronsPath())).toBe(true);
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unchanged behaviour: a POPULATED config.json still migrates on --force.
  // This arm exists so the guard cannot be widened into a no-op by accident.
  // -------------------------------------------------------------------------
  it('UNCHANGED: --force with a populated config.json still migrates (documented full replace)', () => {
    seedLiveCrons();
    const configPath = writeConfig(
      JSON.stringify({
        name: AGENT,
        crons: [
          { name: 'from-config', type: 'recurring', interval: '6h', prompt: 'seeded by config' },
        ],
      }),
    );

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    const after = readCrons(AGENT);
    expect(after.map((c) => c.name)).toEqual(['from-config']);
    expect(isMigrated(tmpCtxRoot, AGENT)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F38 — --force must not silently RE-ENABLE a cron paused in the live store.
  //
  // The pause is applied to crons.json (update-cron / dashboard). config.json has
  // no channel to learn about it, so a straight re-convert stamps enabled:true over
  // the operator's intent and the cron resumes firing. Observed twice in production
  // on one cron. Documentation was tried as the remedy and did not hold, so this is
  // pinned in code.
  // -------------------------------------------------------------------------
  it('F38: a cron paused in crons.json is NOT re-enabled by --force', () => {
    writeCrons(AGENT, [
      {
        name: 'subtitle-backfill',
        prompt: 'paused by the operator',
        schedule: '6h',
        enabled: false,
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    mkdirSync(join(tmpCtxRoot, CRONS_DIR, AGENT), { recursive: true });
    writeFileSync(markerPath(), '', 'utf-8');

    // config.json says nothing about enablement — the historical "unconditional" case.
    const configPath = writeConfig(
      JSON.stringify({
        name: AGENT,
        crons: [
          { name: 'subtitle-backfill', type: 'recurring', interval: '6h', prompt: 'seeded' },
        ],
      }),
    );

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    expect(result.status).toBe('migrated');
    const after = readCrons(AGENT);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('subtitle-backfill');
    expect(after[0].enabled).toBe(false);
  });

  it('F38 NEGATIVE CONTROL: a cron ENABLED in the live store is not forced off', () => {
    // The fence must be one-directional. If it disabled everything it would pass the
    // arm above while destroying the feature, so this arm is what makes that one mean
    // something.
    writeCrons(AGENT, [
      {
        name: 'live-and-enabled',
        prompt: 'running',
        schedule: '6h',
        enabled: true,
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    mkdirSync(join(tmpCtxRoot, CRONS_DIR, AGENT), { recursive: true });
    writeFileSync(markerPath(), '', 'utf-8');

    const configPath = writeConfig(
      JSON.stringify({
        name: AGENT,
        crons: [
          { name: 'live-and-enabled', type: 'recurring', interval: '6h', prompt: 'seeded' },
        ],
      }),
    );

    migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, { force: true, log: () => {} });

    const after = readCrons(AGENT);
    expect(after).toHaveLength(1);
    expect(after[0].enabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F39 — resolve the leg at the READER, never at the field.
  //
  // `enabled` was writable in config.json and absent from the CronEntry interface,
  // so the reader resolved pause intent from `type` alone and discarded it. On disk
  // the key looked authoritative; in behaviour it was inert.
  // -------------------------------------------------------------------------
  it('F39: config.json "enabled": false is honoured, not silently discarded', () => {
    const configPath = writeConfig(
      JSON.stringify({
        name: AGENT,
        crons: [
          {
            name: 'paused-in-config',
            type: 'recurring',
            interval: '6h',
            prompt: 'operator wrote enabled:false here',
            enabled: false,
          },
        ],
      }),
    );

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, { log: () => {} });

    expect(result.status).toBe('migrated');
    const after = readCrons(AGENT);
    expect(after).toHaveLength(1);
    expect(after[0].enabled).toBe(false);
  });

  it('F39 NEGATIVE CONTROL: "enabled": true and an absent key both migrate as enabled', () => {
    const configPath = writeConfig(
      JSON.stringify({
        name: AGENT,
        crons: [
          { name: 'explicit-true', type: 'recurring', interval: '6h', prompt: 'p', enabled: true },
          { name: 'key-absent', type: 'recurring', interval: '6h', prompt: 'p' },
        ],
      }),
    );

    migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, { log: () => {} });

    const after = readCrons(AGENT);
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.enabled === true)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The non-force daemon path is gated by the marker and must be untouched.
  // -------------------------------------------------------------------------
  it('UNCHANGED: without --force the marker still short-circuits everything', () => {
    seedLiveCrons();
    const configPath = writeConfig(JSON.stringify({ name: AGENT }));

    const result = migrateCronsForAgent(AGENT, configPath, tmpCtxRoot, { log: () => {} });

    expect(result.status).toBe('skipped-already-migrated');
    expect(readCrons(AGENT)).toHaveLength(2);
  });
});
