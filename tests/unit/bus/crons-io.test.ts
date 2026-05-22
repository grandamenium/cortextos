/**
 * tests/unit/bus/crons-io.test.ts — Subtask 1.2 I/O module tests.
 *
 * Each test group uses a fresh tempdir via CTX_ROOT so file paths never
 * collide across tests.  Cleanup is best-effort (rmSync in afterEach).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crons-io-test-'));
  process.env.CTX_ROOT = tmpRoot;
  // Re-import module so path resolution picks up the new CTX_ROOT.
  // Because vitest caches modules we bypass the cache by resetting modules.
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Dynamic import helper — ensures CTX_ROOT is set before module resolves paths.
// ---------------------------------------------------------------------------

async function importCrons() {
  const mod = await import('../../../src/bus/crons.js');
  return mod;
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

function makeHeartbeat(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Read HEARTBEAT.md and execute the heartbeat workflow.',
    schedule: '6h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAltCron(name: string): CronDefinition {
  return {
    name,
    prompt: `Execute ${name} workflow.`,
    schedule: '24h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// readCrons
// ---------------------------------------------------------------------------

describe('readCrons', () => {
  it('returns [] for a missing file', async () => {
    const { readCrons } = await importCrons();
    expect(readCrons('boris')).toEqual([]);
  });

  it('returns [] and writes a warning to stderr for corrupted JSON', async () => {
    const { readCrons } = await importCrons();

    // Write garbage JSON into the expected path
    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'crons.json'), '{ this is not valid json }', 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const result = readCrons('boris');

    expect(result).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[crons] WARNING')
    );
    stderrSpy.mockRestore();
  });

  it('returns [] and warns for valid JSON with wrong shape (bare array)', async () => {
    const { readCrons } = await importCrons();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'paul');
    mkdirSync(agentDir, { recursive: true });
    // Write a bare array — wrong envelope shape
    writeFileSync(join(agentDir, 'crons.json'), JSON.stringify([]), 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const result = readCrons('paul');

    expect(result).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[crons] WARNING')
    );
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// readCronsWithStatus — corruption-vs-legitimately-empty disambiguation (iter 9)
// ---------------------------------------------------------------------------

describe('readCronsWithStatus', () => {
  it('reports corrupt:false when the file is missing (legitimately empty)', async () => {
    const { readCronsWithStatus } = await importCrons();
    expect(readCronsWithStatus('boris')).toEqual({ crons: [], corrupt: false });
  });

  it('reports corrupt:false when the file parses to an empty crons array', async () => {
    const { readCronsWithStatus } = await importCrons();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'crons.json'),
      JSON.stringify({ updated_at: '2026-05-01T00:00:00Z', crons: [] }),
      'utf-8',
    );

    const result = readCronsWithStatus('boris');
    expect(result).toEqual({ crons: [], corrupt: false });
  });

  it('reports corrupt:false and recovers from .bak when primary is unparseable but .bak is good', async () => {
    const { readCronsWithStatus, writeCrons } = await importCrons();

    // First write produces no .bak (no prior file). Second write copies the
    // first file to .bak before overwriting.
    writeCrons('boris', [makeHeartbeat()]);
    writeCrons('boris', [makeHeartbeat({ name: 'second' })]);

    const cronsPath = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris', 'crons.json');
    // Corrupt the primary, leave .bak alone (which contains [{name:'heartbeat',...}])
    writeFileSync(cronsPath, '{ broken json', 'utf-8');

    const result = readCronsWithStatus('boris');
    expect(result.corrupt).toBe(false);
    expect(result.crons.map(c => c.name)).toEqual(['heartbeat']);
  });

  it('reports corrupt:true when both primary and .bak are unparseable', async () => {
    const { readCronsWithStatus, writeCrons } = await importCrons();

    writeCrons('boris', [makeHeartbeat()]);
    writeCrons('boris', [makeHeartbeat({ name: 'second' })]); // creates .bak

    const cronsPath = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris', 'crons.json');
    const bakPath   = cronsPath + '.bak';
    writeFileSync(cronsPath, '{ broken', 'utf-8');
    writeFileSync(bakPath,   '<<< also broken', 'utf-8');

    const result = readCronsWithStatus('boris');
    expect(result).toEqual({ crons: [], corrupt: true });
  });

  it('reports corrupt:true when primary is unparseable and .bak does not exist', async () => {
    const { readCronsWithStatus } = await importCrons();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'crons.json'), '{ broken', 'utf-8');
    // No .bak written.

    const result = readCronsWithStatus('boris');
    expect(result).toEqual({ crons: [], corrupt: true });
  });
});

// ---------------------------------------------------------------------------
// writeCrons + readCrons roundtrip
// ---------------------------------------------------------------------------

describe('writeCrons + readCrons roundtrip', () => {
  it('preserves all fields on a single cron', async () => {
    const { readCrons, writeCrons } = await importCrons();

    const cron: CronDefinition = {
      name: 'morning-briefing',
      prompt: 'Prepare and send the morning briefing.',
      schedule: '0 13 * * *',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
      description: 'Daily 09:00 ET briefing.',
      last_fired_at: '2026-04-28T13:00:01.042Z',
      fire_count: 14,
      metadata: { priority: 'high', source: '/loop' },
    };

    writeCrons('boris', [cron]);
    const result = readCrons('boris');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(cron);
  });

  it('preserves multiple crons in insertion order', async () => {
    const { readCrons, writeCrons } = await importCrons();

    const crons = [
      makeHeartbeat(),
      makeAltCron('autoresearch'),
      makeAltCron('weekly-report'),
    ];

    writeCrons('paul', crons);
    const result = readCrons('paul');

    expect(result).toHaveLength(3);
    expect(result.map(c => c.name)).toEqual(['heartbeat', 'autoresearch', 'weekly-report']);
  });

  it('roundtrip handles empty array', async () => {
    const { readCrons, writeCrons } = await importCrons();
    writeCrons('boris', []);
    expect(readCrons('boris')).toEqual([]);
  });

  it('creates the directory if it does not exist', async () => {
    const { readCrons, writeCrons } = await importCrons();

    // Directory does not exist yet
    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'new-agent');
    expect(existsSync(agentDir)).toBe(false);

    writeCrons('new-agent', [makeHeartbeat()]);
    expect(readCrons('new-agent')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updated_at envelope field
// ---------------------------------------------------------------------------

describe('updated_at envelope', () => {
  it('is written on every writeCrons call', async () => {
    const { writeCrons } = await importCrons();

    const before = new Date().toISOString();
    writeCrons('boris', [makeHeartbeat()]);
    const after = new Date().toISOString();

    const filePath = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris', 'crons.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8') as string) as {
      updated_at: string;
      crons: CronDefinition[];
    };

    expect(raw.updated_at).toBeDefined();
    expect(raw.updated_at >= before).toBe(true);
    expect(raw.updated_at <= after).toBe(true);
  });

  it('is refreshed on each write', async () => {
    const { writeCrons } = await importCrons();

    writeCrons('boris', [makeHeartbeat()]);
    const filePath = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris', 'crons.json');

    const first = (JSON.parse(readFileSync(filePath, 'utf-8') as string) as { updated_at: string }).updated_at;

    writeCrons('boris', [makeHeartbeat(), makeAltCron('autoresearch')]);
    const second = (JSON.parse(readFileSync(filePath, 'utf-8') as string) as { updated_at: string }).updated_at;

    // second >= first (timestamps only move forward)
    expect(second >= first).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addCron
// ---------------------------------------------------------------------------

describe('addCron', () => {
  it('adds a cron when none exist yet', async () => {
    const { addCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    expect(readCrons('boris')).toHaveLength(1);
  });

  it('adds multiple crons without collision', async () => {
    const { addCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    addCron('boris', makeAltCron('autoresearch'));
    expect(readCrons('boris')).toHaveLength(2);
  });

  it('throws with the expected message on duplicate name', async () => {
    const { addCron } = await importCrons();
    addCron('boris', makeHeartbeat());
    expect(() => addCron('boris', makeHeartbeat())).toThrowError(
      'cron "heartbeat" already exists for agent "boris"'
    );
  });

  it('duplicate check is scoped per agent — same name on different agent is allowed', async () => {
    const { addCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    // paul is a different agent — should succeed
    expect(() => addCron('paul', makeHeartbeat())).not.toThrow();
    expect(readCrons('paul')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeCron
// ---------------------------------------------------------------------------

describe('removeCron', () => {
  it('returns false when the cron does not exist', async () => {
    const { removeCron } = await importCrons();
    expect(removeCron('boris', 'nonexistent')).toBe(false);
  });

  it('returns true and removes the cron when it exists', async () => {
    const { addCron, removeCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    const result = removeCron('boris', 'heartbeat');
    expect(result).toBe(true);
    expect(readCrons('boris')).toEqual([]);
  });

  it('removes only the targeted cron, leaving others intact', async () => {
    const { addCron, removeCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    addCron('boris', makeAltCron('autoresearch'));
    removeCron('boris', 'heartbeat');
    const remaining = readCrons('boris');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('autoresearch');
  });

  it('is idempotent — removing an already-removed cron returns false, no throw', async () => {
    const { addCron, removeCron } = await importCrons();
    addCron('boris', makeHeartbeat());
    removeCron('boris', 'heartbeat');
    expect(() => removeCron('boris', 'heartbeat')).not.toThrow();
    expect(removeCron('boris', 'heartbeat')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateCron
// ---------------------------------------------------------------------------

describe('updateCron', () => {
  it('returns false for a missing cron name', async () => {
    const { updateCron } = await importCrons();
    expect(updateCron('boris', 'nonexistent', { enabled: false })).toBe(false);
  });

  it('returns true and applies patch for an existing cron', async () => {
    const { addCron, updateCron, readCrons } = await importCrons();
    addCron('boris', makeHeartbeat());
    const result = updateCron('boris', 'heartbeat', { enabled: false });
    expect(result).toBe(true);
    const cron = readCrons('boris')[0];
    expect(cron.enabled).toBe(false);
  });

  it('patches last_fired_at correctly', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    addCron('boris', makeHeartbeat());
    updateCron('boris', 'heartbeat', { last_fired_at: '2026-04-29T12:00:00.000Z' });
    const cron = getCronByName('boris', 'heartbeat');
    expect(cron?.last_fired_at).toBe('2026-04-29T12:00:00.000Z');
  });

  it('patches fire_count correctly', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    addCron('boris', makeHeartbeat());
    updateCron('boris', 'heartbeat', { fire_count: 42 });
    const cron = getCronByName('boris', 'heartbeat');
    expect(cron?.fire_count).toBe(42);
  });

  it('patch merges — unpatched fields are preserved', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    const original = makeHeartbeat({ description: 'original description', fire_count: 5 });
    addCron('boris', original);
    updateCron('boris', 'heartbeat', { enabled: false });

    const cron = getCronByName('boris', 'heartbeat');
    expect(cron?.description).toBe('original description');
    expect(cron?.fire_count).toBe(5);
    expect(cron?.enabled).toBe(false);
  });

  it('patch cannot rename a cron (name field in patch is ignored)', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    addCron('boris', makeHeartbeat());
    updateCron('boris', 'heartbeat', { name: 'new-name' } as Partial<CronDefinition>);
    // Original name still present
    expect(getCronByName('boris', 'heartbeat')).toBeDefined();
    // New name does not exist
    expect(getCronByName('boris', 'new-name')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getCronByName
// ---------------------------------------------------------------------------

describe('getCronByName', () => {
  it('returns undefined for a missing name', async () => {
    const { getCronByName } = await importCrons();
    expect(getCronByName('boris', 'nonexistent')).toBeUndefined();
  });

  it('returns the correct cron when found', async () => {
    const { addCron, getCronByName } = await importCrons();
    const cron = makeHeartbeat();
    addCron('boris', cron);
    const found = getCronByName('boris', 'heartbeat');
    expect(found).toBeDefined();
    expect(found?.name).toBe('heartbeat');
    expect(found?.schedule).toBe('6h');
  });

  it('returns undefined for missing agent (no file)', async () => {
    const { getCronByName } = await importCrons();
    expect(getCronByName('ghost-agent', 'heartbeat')).toBeUndefined();
  });

  it('finds the right cron among multiple', async () => {
    const { addCron, getCronByName } = await importCrons();
    addCron('boris', makeHeartbeat());
    addCron('boris', makeAltCron('autoresearch'));
    addCron('boris', makeAltCron('weekly-report'));

    expect(getCronByName('boris', 'autoresearch')?.name).toBe('autoresearch');
    expect(getCronByName('boris', 'weekly-report')?.name).toBe('weekly-report');
    expect(getCronByName('boris', 'heartbeat')?.name).toBe('heartbeat');
  });
});
