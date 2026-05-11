/**
 * tests/unit/bus/crons-config-sync.test.ts
 *
 * Tests for the auto-sync behaviour: after each successful addCron / removeCron /
 * updateCron the agent's config.json crons[] must be updated to mirror the
 * runtime crons.json, with the required schema transform applied.
 *
 * Per-test isolation: fresh tmpdir for both CTX_ROOT (runtime state) and
 * CTX_FRAMEWORK_ROOT (declarative config.json location).  vi.resetModules()
 * ensures CTX_ROOT and CTX_FRAMEWORK_ROOT are picked up on every import.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition, CronEntry } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;      // CTX_ROOT — runtime state lives here
let fwRoot: string;       // CTX_FRAMEWORK_ROOT — config.json lives here

const originalCtxRoot = process.env.CTX_ROOT;
const originalFwRoot = process.env.CTX_FRAMEWORK_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crons-cfg-sync-'));
  fwRoot = mkdtempSync(join(tmpdir(), 'crons-cfg-fwroot-'));
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = fwRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  if (originalFwRoot !== undefined) {
    process.env.CTX_FRAMEWORK_ROOT = originalFwRoot;
  } else {
    delete process.env.CTX_FRAMEWORK_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(fwRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

/** Write a minimal config.json for the agent under fwRoot/orgs/<org>/agents/<agent>/. */
function writeConfigJson(
  org: string,
  agentName: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(fwRoot, 'orgs', org, 'agents', agentName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ agent_name: agentName, enabled: true, crons: [], ...extra }, null, 2));
  return path;
}

function readConfigJson(org: string, agentName: string): Record<string, unknown> {
  const path = join(fwRoot, 'orgs', org, 'agents', agentName, 'config.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Run the heartbeat workflow.',
    schedule: '4h',
    enabled: true,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// addCron — writes to both runtime crons.json AND config.json
// ---------------------------------------------------------------------------

describe('addCron — dual write', () => {
  it('writes the new cron to config.json with schema transform', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron } = await importCrons();

    // Reviewer Medium #3: verify happy path emits no warnings
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    addCron('boris', makeCron({ schedule: '4h' }));

    const cfg = readConfigJson('lifeos', 'boris');
    const cronEntries = cfg['crons'] as CronEntry[];
    expect(cronEntries).toHaveLength(1);

    const entry = cronEntries[0];
    // schedule → interval
    expect(entry.interval).toBe('4h');
    expect((entry as CronDefinition & { schedule?: string }).schedule).toBeUndefined();
    // type defaults to 'recurring' when no metadata.original_type
    expect(entry.type).toBe('recurring');
    // name and prompt copied verbatim
    expect(entry.name).toBe('heartbeat');
    expect(entry.prompt).toBe('Run the heartbeat workflow.');
    // Runtime-only fields must not appear
    expect((entry as Record<string, unknown>)['enabled']).toBeUndefined();
    expect((entry as Record<string, unknown>)['created_at']).toBeUndefined();
    expect((entry as Record<string, unknown>)['metadata']).toBeUndefined();
    expect((entry as Record<string, unknown>)['fire_count']).toBeUndefined();

    // Happy path must not emit any stderr warnings.
    const warningCalls = stderrSpy.mock.calls.filter(args =>
      String(args[0]).includes('[crons] WARNING'),
    );
    expect(warningCalls).toEqual([]);
    stderrSpy.mockRestore();
  });

  it('picks up type from metadata.original_type when present', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron } = await importCrons();

    addCron('boris', makeCron({
      metadata: { original_type: 'once', migrated_from_config: true },
    }));

    const cfg = readConfigJson('lifeos', 'boris');
    const entry = (cfg['crons'] as CronEntry[])[0];
    expect(entry.type).toBe('once');
  });

  it('writes to runtime crons.json AND config.json simultaneously', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, readCrons } = await importCrons();

    addCron('boris', makeCron());

    // Runtime: crons.json must have 1 entry in full CronDefinition format
    const runtime = readCrons('boris');
    expect(runtime).toHaveLength(1);
    expect(runtime[0].schedule).toBe('4h');
    expect(runtime[0].enabled).toBe(true);

    // Config: config.json must have 1 entry in CronEntry format
    const cfg = readConfigJson('lifeos', 'boris');
    expect((cfg['crons'] as CronEntry[])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeCron — removes from both files
// ---------------------------------------------------------------------------

describe('removeCron — dual remove', () => {
  it('removes the cron from config.json', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, removeCron } = await importCrons();

    addCron('boris', makeCron({ name: 'heartbeat' }));
    addCron('boris', makeCron({ name: 'weekly-report', schedule: '7d' }));

    removeCron('boris', 'heartbeat');

    const cfg = readConfigJson('lifeos', 'boris');
    const entries = cfg['crons'] as CronEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('weekly-report');
  });

  it('runtime crons.json and config.json both reflect the removal', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, removeCron, readCrons } = await importCrons();

    addCron('boris', makeCron());
    removeCron('boris', 'heartbeat');

    expect(readCrons('boris')).toHaveLength(0);
    const cfg = readConfigJson('lifeos', 'boris');
    expect((cfg['crons'] as CronEntry[])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateCron — updates both files
// ---------------------------------------------------------------------------

describe('updateCron — dual update', () => {
  it('updates prompt change in config.json', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, updateCron } = await importCrons();

    addCron('boris', makeCron({ prompt: 'old prompt' }));
    updateCron('boris', 'heartbeat', { prompt: 'new prompt' });

    const cfg = readConfigJson('lifeos', 'boris');
    const entry = (cfg['crons'] as CronEntry[])[0];
    expect(entry.prompt).toBe('new prompt');
  });

  it('updates schedule change in config.json (interval is renamed schedule)', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, updateCron } = await importCrons();

    addCron('boris', makeCron({ schedule: '4h' }));
    updateCron('boris', 'heartbeat', { schedule: '1d' });

    const cfg = readConfigJson('lifeos', 'boris');
    const entry = (cfg['crons'] as CronEntry[])[0];
    expect(entry.interval).toBe('1d');
  });

  it('runtime and config.json are both updated consistently', async () => {
    writeConfigJson('lifeos', 'boris');
    const { addCron, updateCron, getCronByName } = await importCrons();

    addCron('boris', makeCron());
    updateCron('boris', 'heartbeat', { schedule: '12h', prompt: 'updated' });

    // Runtime
    const rt = getCronByName('boris', 'heartbeat');
    expect(rt?.schedule).toBe('12h');
    expect(rt?.prompt).toBe('updated');

    // Config
    const cfg = readConfigJson('lifeos', 'boris');
    const entry = (cfg['crons'] as CronEntry[])[0];
    expect(entry.interval).toBe('12h');
    expect(entry.prompt).toBe('updated');
  });
});

// ---------------------------------------------------------------------------
// Graceful failure: missing config.json
// ---------------------------------------------------------------------------

describe('addCron — graceful failure when config.json is missing', () => {
  it('runtime write succeeds even when config.json does not exist', async () => {
    // Create the orgs/ structure so the org dir exists, but do NOT create config.json.
    // Use enabled-agents.json to give a firm org hint, so resolveConfigJsonPath
    // can build the candidate path and then detect the missing file.
    mkdirSync(join(fwRoot, 'orgs', 'lifeos', 'agents'), { recursive: true });
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { org: 'lifeos', enabled: true } }),
      'utf-8',
    );

    const { addCron, readCrons } = await importCrons();

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    addCron('boris', makeCron());

    // Runtime write succeeded.
    expect(readCrons('boris')).toHaveLength(1);

    // Warning emitted.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[crons] WARNING: config.json sync failed for agent "boris"')
    );

    stderrSpy.mockRestore();
  });

  it('does not throw when config.json is absent', async () => {
    mkdirSync(join(fwRoot, 'orgs', 'lifeos', 'agents'), { recursive: true });
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { org: 'lifeos', enabled: true } }),
      'utf-8',
    );
    const { addCron } = await importCrons();
    expect(() => addCron('boris', makeCron())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Graceful failure: unparseable config.json
// ---------------------------------------------------------------------------

describe('addCron — graceful failure when config.json has invalid JSON', () => {
  it('runtime write succeeds and a warning is emitted', async () => {
    const dir = join(fwRoot, 'orgs', 'lifeos', 'agents', 'boris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ this is not valid json }', 'utf-8');

    const { addCron, readCrons } = await importCrons();

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    addCron('boris', makeCron());

    expect(readCrons('boris')).toHaveLength(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[crons] WARNING: config.json sync failed for agent "boris"')
    );

    stderrSpy.mockRestore();
  });

  it('does not throw on unparseable config.json', async () => {
    const dir = join(fwRoot, 'orgs', 'lifeos', 'agents', 'boris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '<<<bad json>>>', 'utf-8');

    const { addCron } = await importCrons();
    expect(() => addCron('boris', makeCron())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-crons fields in config.json are preserved
// ---------------------------------------------------------------------------

describe('non-crons fields preserved across sync', () => {
  it('preserves all non-crons fields after addCron', async () => {
    writeConfigJson('lifeos', 'boris', {
      model: 'claude-opus-4-5',
      timezone: 'America/New_York',
      startup_delay: 5,
      custom_flag: 'hello',
    });
    const { addCron } = await importCrons();

    addCron('boris', makeCron());

    const cfg = readConfigJson('lifeos', 'boris');
    expect(cfg['model']).toBe('claude-opus-4-5');
    expect(cfg['timezone']).toBe('America/New_York');
    expect(cfg['startup_delay']).toBe(5);
    expect(cfg['custom_flag']).toBe('hello');
    expect(cfg['agent_name']).toBe('boris');
  });

  it('preserves non-crons fields after removeCron', async () => {
    writeConfigJson('lifeos', 'boris', { model: 'claude-sonnet-4-6' });
    const { addCron, removeCron } = await importCrons();

    addCron('boris', makeCron());
    removeCron('boris', 'heartbeat');

    const cfg = readConfigJson('lifeos', 'boris');
    expect(cfg['model']).toBe('claude-sonnet-4-6');
  });

  it('preserves non-crons fields after updateCron', async () => {
    writeConfigJson('lifeos', 'boris', { max_session_seconds: 3600 });
    const { addCron, updateCron } = await importCrons();

    addCron('boris', makeCron());
    updateCron('boris', 'heartbeat', { prompt: 'new prompt' });

    const cfg = readConfigJson('lifeos', 'boris');
    expect(cfg['max_session_seconds']).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// No CTX_FRAMEWORK_ROOT — sync skipped silently
// ---------------------------------------------------------------------------

describe('no CTX_FRAMEWORK_ROOT — sync is a no-op', () => {
  it('addCron succeeds without CTX_FRAMEWORK_ROOT set', async () => {
    delete process.env.CTX_FRAMEWORK_ROOT;
    vi.resetModules();

    const { addCron, readCrons } = await importCrons();
    addCron('boris', makeCron());
    expect(readCrons('boris')).toHaveLength(1);
  });
});
