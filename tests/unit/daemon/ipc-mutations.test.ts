/**
 * tests/unit/daemon/ipc-mutations.test.ts — Subtask 4.2
 *
 * Unit tests for the add-cron, update-cron, and remove-cron IPC mutation handlers
 * exported from src/daemon/ipc-server.ts:
 *   - handleAddCron
 *   - handleUpdateCron
 *   - handleRemoveCron
 *   - isValidSchedule
 *
 * Uses fresh per-test tempdir (CTX_ROOT) and vi.resetModules() to isolate
 * module-level state (same pattern as ipc-list-crons.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ipc-mut-test-'));
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
// File helpers
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';

function writeCronsJson(agentName: string, crons: CronDefinition[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeEnabledAgents(
  agents: Record<string, { enabled?: boolean; org?: string }>,
): void {
  const configDir = join(tmpRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify(agents, null, 2));
}

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Run heartbeat.',
    schedule: '6h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isValidSchedule
// ---------------------------------------------------------------------------

describe('isValidSchedule', () => {
  it('accepts interval shorthands', async () => {
    const { isValidSchedule } = await import('../../../src/daemon/ipc-server.js');
    expect(isValidSchedule('6h')).toBe(true);
    expect(isValidSchedule('30m')).toBe(true);
    expect(isValidSchedule('1d')).toBe(true);
    expect(isValidSchedule('2w')).toBe(true);
    expect(isValidSchedule('5s')).toBe(true);
  });

  it('accepts valid 5-field cron expressions', async () => {
    const { isValidSchedule } = await import('../../../src/daemon/ipc-server.js');
    expect(isValidSchedule('0 9 * * *')).toBe(true);
    expect(isValidSchedule('*/15 * * * *')).toBe(true);
    expect(isValidSchedule('0 0,6,12,18 * * *')).toBe(true);
    expect(isValidSchedule('0 16 * * 1')).toBe(true);
  });

  it('rejects invalid schedules', async () => {
    const { isValidSchedule } = await import('../../../src/daemon/ipc-server.js');
    expect(isValidSchedule('')).toBe(false);
    expect(isValidSchedule('abc')).toBe(false);
    expect(isValidSchedule('6 hours')).toBe(false);
    expect(isValidSchedule('0 9 * *')).toBe(false); // only 4 fields
  });

  it('rejects whitespace-only string', async () => {
    const { isValidSchedule } = await import('../../../src/daemon/ipc-server.js');
    expect(isValidSchedule('   ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAddCron
// ---------------------------------------------------------------------------

describe('handleAddCron — happy path', () => {
  it('creates a new cron and returns ok:true', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    const { handleAddCron, readCrons } = await import('../../../src/daemon/ipc-server.js')
      .then(async ipc => ({
        handleAddCron: ipc.handleAddCron,
        readCrons: (await import('../../../src/bus/crons.js')).readCrons,
      }));

    const result = handleAddCron('boris', {
      name: 'heartbeat',
      prompt: 'Run heartbeat.',
      schedule: '6h',
      enabled: true,
    });

    expect(result.ok).toBe(true);
    const crons = readCrons('boris');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');
  });

  it('sets created_at automatically', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    const before = new Date().toISOString();
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('boris', {
      name: 'heartbeat',
      prompt: 'x',
      schedule: '1h',
    });
    const { readCrons } = await import('../../../src/bus/crons.js');
    const cron = readCrons('boris')[0];
    expect(cron.created_at).toBeDefined();
    expect(cron.created_at >= before).toBe(true);
  });

  it('accepts cron expression as schedule', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', {
      name: 'morning-briefing',
      prompt: 'Send briefing.',
      schedule: '0 9 * * *',
    });
    expect(result.ok).toBe(true);
  });

  it('defaults enabled to true when absent', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'test', prompt: 'x', schedule: '1h' });
    const { readCrons } = await import('../../../src/bus/crons.js');
    expect(readCrons('boris')[0].enabled).toBe(true);
  });

  it('respects enabled:false', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'test', prompt: 'x', schedule: '1h', enabled: false });
    const { readCrons } = await import('../../../src/bus/crons.js');
    expect(readCrons('boris')[0].enabled).toBe(false);
  });

  it('allows add when enabled-agents.json is absent (graceful skip)', async () => {
    // No enabled-agents.json written — validator skips the check
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', {
      name: 'test',
      prompt: 'x',
      schedule: '1h',
    });
    expect(result.ok).toBe(true);
  });
});

describe('handleAddCron — validation failures', () => {
  it('rejects missing agent', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron(undefined, { name: 'test', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('agent');
    expect(result.error).toMatch(/agent/i);
  });

  it('rejects unknown agent when enabled-agents.json exists', async () => {
    writeEnabledAgents({ paul: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('nonexistent', { name: 'test', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('agent');
    expect(result.error).toContain('nonexistent');
    expect(result.error).toContain('paul'); // lists enabled agents
  });

  it('rejects missing definition', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', undefined);
    expect(result.ok).toBe(false);
    expect(result.field).toBe('definition');
  });

  it('rejects empty cron name', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: '', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
  });

  it('rejects cron name with whitespace', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'has space', prompt: 'x', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
  });

  it('rejects invalid schedule', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: 'x', schedule: 'bad-schedule' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
    expect(result.error).toContain('bad-schedule');
  });

  it('rejects "6 hours" as schedule', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: 'x', schedule: '6 hours' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
  });

  it('rejects empty prompt', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: '', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('prompt');
  });

  it('rejects whitespace-only prompt', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('boris', { name: 'test', prompt: '   ', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('prompt');
  });

  it('returns error and field:name on duplicate cron', async () => {
    writeEnabledAgents({ boris: { enabled: true } });
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('boris', { name: 'heartbeat', prompt: 'x', schedule: '6h' });
    const result = handleAddCron('boris', { name: 'heartbeat', prompt: 'y', schedule: '1h' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
    expect(result.error).toContain('heartbeat');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCron
// ---------------------------------------------------------------------------

describe('handleUpdateCron — happy path', () => {
  it('updates schedule and returns ok:true', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'heartbeat', { schedule: '1d' });
    expect(result.ok).toBe(true);

    const { getCronByName } = await import('../../../src/bus/crons.js');
    const cron = getCronByName('boris', 'heartbeat');
    expect(cron?.schedule).toBe('1d');
  });

  it('updates enabled flag', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    handleUpdateCron('boris', 'heartbeat', { enabled: false });
    const { getCronByName } = await import('../../../src/bus/crons.js');
    expect(getCronByName('boris', 'heartbeat')?.enabled).toBe(false);
  });

  it('updates prompt', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    handleUpdateCron('boris', 'heartbeat', { prompt: 'New prompt.' });
    const { getCronByName } = await import('../../../src/bus/crons.js');
    expect(getCronByName('boris', 'heartbeat')?.prompt).toBe('New prompt.');
  });

  it('accepts cron expression in schedule patch', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'heartbeat', { schedule: '0 9 * * *' });
    expect(result.ok).toBe(true);
  });
});

describe('handleUpdateCron — validation failures', () => {
  it('rejects missing agent', async () => {
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron(undefined, 'heartbeat', { enabled: false });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('agent');
  });

  it('rejects missing cron name', async () => {
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', undefined, { enabled: false });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
  });

  it('rejects missing patch', async () => {
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'heartbeat', undefined);
    expect(result.ok).toBe(false);
    expect(result.field).toBe('patch');
  });

  it('rejects invalid schedule in patch', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'heartbeat', { schedule: 'abc' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('schedule');
  });

  it('rejects whitespace-only prompt in patch', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'heartbeat', { prompt: '   ' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('prompt');
  });

  it('returns error when cron not found', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleUpdateCron('boris', 'nonexistent', { enabled: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
    expect(result.error).toContain('boris');
  });
});

// ---------------------------------------------------------------------------
// handleRemoveCron
// ---------------------------------------------------------------------------

describe('handleRemoveCron — happy path', () => {
  it('removes cron and returns ok:true', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleRemoveCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleRemoveCron('boris', 'heartbeat');
    expect(result.ok).toBe(true);

    const { readCrons } = await import('../../../src/bus/crons.js');
    expect(readCrons('boris')).toHaveLength(0);
  });

  it('removes only the targeted cron', async () => {
    writeCronsJson('boris', [
      makeCron({ name: 'heartbeat' }),
      makeCron({ name: 'daily-report', schedule: '24h' }),
    ]);
    const { handleRemoveCron } = await import('../../../src/daemon/ipc-server.js');
    handleRemoveCron('boris', 'heartbeat');

    const { readCrons } = await import('../../../src/bus/crons.js');
    const remaining = readCrons('boris');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('daily-report');
  });
});

describe('handleRemoveCron — validation failures', () => {
  it('rejects missing agent', async () => {
    const { handleRemoveCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleRemoveCron(undefined, 'heartbeat');
    expect(result.ok).toBe(false);
    expect(result.field).toBe('agent');
  });

  it('rejects missing cron name', async () => {
    const { handleRemoveCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleRemoveCron('boris', undefined);
    expect(result.ok).toBe(false);
    expect(result.field).toBe('name');
  });

  it('returns error when cron not found', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleRemoveCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleRemoveCron('boris', 'nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
  });
});
