/**
 * tests/integration/ipc-cron-mutations.test.ts — Subtask 4.2
 *
 * Integration test: IPC mutation handlers (add/update/remove-cron) wired
 * together with the bus/crons I/O layer.
 *
 * Tests:
 *   - Full add → verify crons.json on disk
 *   - Update → verify patch persisted
 *   - Delete → verify removed from crons.json
 *   - Error cases: invalid interval, duplicate name, missing agent
 *
 * No daemon process is spawned.  Uses fresh per-test CTX_ROOT tempdir.
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
import type { CronDefinition } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ipc-mut-integ-'));
  process.env.CTX_ROOT = tmpRoot;
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
// Helpers
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';

function writeEnabledAgents(
  agents: Record<string, { enabled?: boolean; org?: string }>,
): void {
  const configDir = join(tmpRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify(agents, null, 2));
}

function readCronsFromDisk(agentName: string): CronDefinition[] {
  const filePath = join(tmpRoot, CRONS_DIR, agentName, 'crons.json');
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  return parsed.crons as CronDefinition[];
}

// ---------------------------------------------------------------------------
// Full round-trip: add → read → update → read → remove → read
// ---------------------------------------------------------------------------

describe('add-cron → update-cron → remove-cron round-trip', () => {
  it('creates, updates, then removes a cron, verifying disk state at each step', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });

    const { handleAddCron, handleUpdateCron, handleRemoveCron } = await import(
      '../../src/daemon/ipc-server.js'
    );

    // Step 1 — Add
    const addResult = handleAddCron('boris', {
      name: 'heartbeat',
      prompt: 'Run heartbeat workflow.',
      schedule: '6h',
      enabled: true,
    });
    expect(addResult.ok).toBe(true);

    let onDisk = readCronsFromDisk('boris');
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].name).toBe('heartbeat');
    expect(onDisk[0].schedule).toBe('6h');
    expect(onDisk[0].enabled).toBe(true);
    expect(onDisk[0].created_at).toBeDefined();

    // Step 2 — Update schedule
    const updateResult = handleUpdateCron('boris', 'heartbeat', { schedule: '1d', enabled: false });
    expect(updateResult.ok).toBe(true);

    onDisk = readCronsFromDisk('boris');
    expect(onDisk[0].schedule).toBe('1d');
    expect(onDisk[0].enabled).toBe(false);
    // Other fields preserved
    expect(onDisk[0].prompt).toBe('Run heartbeat workflow.');

    // Step 3 — Remove
    const removeResult = handleRemoveCron('boris', 'heartbeat');
    expect(removeResult.ok).toBe(true);

    onDisk = readCronsFromDisk('boris');
    expect(onDisk).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// add-cron — error cases
// ---------------------------------------------------------------------------

describe('add-cron error cases', () => {
  it('rejects invalid interval "abc"', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: 'x', schedule: 'abc' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
  });

  it('rejects "6 hours" (natural language, not a shorthand)', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: 'x', schedule: '6 hours' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
  });

  it('rejects duplicate cron name — disk not modified on collision', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'heartbeat', prompt: 'x', schedule: '6h' });
    const before = readCronsFromDisk('boris');

    const result = handleAddCron('boris', { name: 'heartbeat', prompt: 'y', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');

    // Disk state unchanged
    const after = readCronsFromDisk('boris');
    expect(after).toEqual(before);
  });

  it('rejects unknown agent when enabled-agents.json exists', async () => {
    writeEnabledAgents({ paul: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    const result = handleAddCron('unknown-agent', { name: 'test', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown-agent');
    expect(result.error).toContain('paul');
  });

  it('rejects cron name with spaces', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'has spaces', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
  });

  it('accepts multiple crons for the same agent', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'cron-a', prompt: 'a', schedule: '6h' });
    handleAddCron('boris', { name: 'cron-b', prompt: 'b', schedule: '24h' });
    handleAddCron('boris', { name: 'cron-c', prompt: 'c', schedule: '0 9 * * *' });

    const onDisk = readCronsFromDisk('boris');
    expect(onDisk).toHaveLength(3);
    expect(onDisk.map(c => c.name)).toEqual(['cron-a', 'cron-b', 'cron-c']);
  });
});

// ---------------------------------------------------------------------------
// update-cron — error cases
// ---------------------------------------------------------------------------

describe('update-cron error cases', () => {
  it('returns error (ok:false) for non-existent cron', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron, handleUpdateCron } = await import('../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'heartbeat', prompt: 'x', schedule: '6h' });

    const result = handleUpdateCron('boris', 'ghost-cron', { enabled: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ghost-cron');
  });

  it('rejects invalid schedule in patch', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron, handleUpdateCron } = await import('../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'heartbeat', prompt: 'x', schedule: '6h' });

    const result = handleUpdateCron('boris', 'heartbeat', { schedule: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
  });
});

// ---------------------------------------------------------------------------
// remove-cron — error cases
// ---------------------------------------------------------------------------

describe('remove-cron error cases', () => {
  it('returns error for non-existent cron', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleRemoveCron } = await import('../../src/daemon/ipc-server.js');
    const result = handleRemoveCron('boris', 'nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('is idempotent — second remove returns error gracefully', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron, handleRemoveCron } = await import('../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'heartbeat', prompt: 'x', schedule: '6h' });
    handleRemoveCron('boris', 'heartbeat');

    const result = handleRemoveCron('boris', 'heartbeat');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidSchedule — comprehensive
// ---------------------------------------------------------------------------

describe('isValidSchedule comprehensive', () => {
  it('accepts all standard interval units', async () => {
    const { isValidSchedule } = await import('../../src/daemon/ipc-server.js');
    for (const s of ['1m', '5m', '1h', '6h', '24h', '1d', '7d', '1w', '2w']) {
      expect(isValidSchedule(s), s).toBe(true);
    }
  });

  it('accepts diverse cron expressions', async () => {
    const { isValidSchedule } = await import('../../src/daemon/ipc-server.js');
    for (const s of [
      '0 9 * * *',
      '*/15 * * * *',
      '0 0,6,12,18 * * *',
      '30 14 * * 1-5',
      '0 16 * * 1',
    ]) {
      expect(isValidSchedule(s), s).toBe(true);
    }
  });

  it('rejects natural language and partial expressions', async () => {
    const { isValidSchedule } = await import('../../src/daemon/ipc-server.js');
    for (const s of [
      '6 hours',
      'every day',
      '',
      '0 9',        // only 2 fields
      '* * *',      // 3 fields
    ]) {
      expect(isValidSchedule(s), s).toBe(false);
    }
  });
});
