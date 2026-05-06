/**
 * tests/unit/daemon/ipc-fleet-health.test.ts — Subtask 4.4
 *
 * Unit tests for the computeFleetHealth() IPC handler and the fleet-health
 * cache invalidation helper.  Uses fresh per-test CTX_ROOT tempdir with
 * seeded crons.json and cron-execution.log files.  No daemon process spawned.
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
import type { CronDefinition, CronExecutionLogEntry } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-health-test-'));
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
  writeFileSync(
    join(configDir, 'enabled-agents.json'),
    JSON.stringify(agents, null, 2),
  );
}

function writeCronsJson(agentName: string, crons: CronDefinition[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeExecutionLog(agentName: string, entries: CronExecutionLogEntry[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

function makeCron(name: string, schedule: string, extra: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name,
    prompt: `Run ${name}.`,
    schedule,
    enabled: true,
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    ...extra,
  };
}

function makeLogEntry(
  cronName: string,
  status: 'fired' | 'retried' | 'failed',
  tsMs: number,
): CronExecutionLogEntry {
  return {
    ts: new Date(tsMs).toISOString(),
    cron: cronName,
    status,
    attempt: 1,
    duration_ms: 250,
    error: status === 'failed' ? 'error msg' : null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeFleetHealth', () => {
  it('returns empty result when no enabled agents', async () => {
    writeEnabledAgents({});
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, Date.now());
    expect(result.summary.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('returns empty result when agents have no crons', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', []);
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, Date.now());
    expect(result.summary.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('marks cron as never-fired when no execution log exists', async () => {
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    // No execution log written
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, Date.now());
    expect(result.summary.total).toBe(1);
    expect(result.summary.neverFired).toBe(1);
    expect(result.rows[0].state).toBe('never-fired');
    expect(result.rows[0].cronName).toBe('heartbeat');
    expect(result.rows[0].agent).toBe('boris');
  });

  it('marks cron as healthy when recently fired', async () => {
    const now = Date.now();
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeExecutionLog('boris', [
      makeLogEntry('heartbeat', 'fired', now - 3_600_000), // fired 1h ago
    ]);
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.summary.healthy).toBe(1);
    expect(result.rows[0].state).toBe('healthy');
  });

  it('marks cron as warning when gap > 2x interval', async () => {
    const now = Date.now();
    const intervalMs = 6 * 3_600_000; // 6h
    const lastFireMs = now - intervalMs * 2 - 1; // just over 2x
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeExecutionLog('boris', [
      makeLogEntry('heartbeat', 'fired', lastFireMs),
    ]);
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.summary.warning).toBe(1);
    expect(result.rows[0].state).toBe('warning');
  });

  it('marks cron as failure when most recent execution failed', async () => {
    const now = Date.now();
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeExecutionLog('boris', [
      makeLogEntry('heartbeat', 'failed', now - 1_000),
    ]);
    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.summary.failure).toBe(1);
    expect(result.rows[0].state).toBe('failure');
  });

  it('handles multiple agents with mixed states', async () => {
    const now = Date.now();
    const intervalMs = 6 * 3_600_000;

    writeEnabledAgents({
      boris: { enabled: true, org: 'lifeos' },
      paul: { enabled: true, org: 'lifeos' },
      nick: { enabled: true, org: 'lifeos' },
    });

    // boris: one healthy cron
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeExecutionLog('boris', [
      makeLogEntry('heartbeat', 'fired', now - 3_600_000),
    ]);

    // paul: one warning cron + one never-fired
    writeCronsJson('paul', [
      makeCron('morning-briefing', '24h'),
      makeCron('weekly-report', '7d'),
    ]);
    writeExecutionLog('paul', [
      makeLogEntry('morning-briefing', 'fired', now - 50 * 3_600_000), // 50h ago, 24h schedule → warning
    ]);
    // weekly-report has no execution log

    // nick: one failure
    writeCronsJson('nick', [makeCron('daily-report', '24h')]);
    writeExecutionLog('nick', [
      makeLogEntry('daily-report', 'failed', now - 1_000),
    ]);

    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    expect(result.summary.total).toBe(4);
    expect(result.summary.healthy).toBe(1);
    expect(result.summary.warning).toBe(1);
    expect(result.summary.failure).toBe(1);
    expect(result.summary.neverFired).toBe(1);

    // Per-agent breakdown
    expect(result.summary.agents['boris'].healthy).toBe(1);
    expect(result.summary.agents['paul'].warning).toBe(1);
    expect(result.summary.agents['paul'].neverFired).toBe(1);
    expect(result.summary.agents['nick'].failure).toBe(1);
  });

  it('respects agentFilter — returns only that agent', async () => {
    const now = Date.now();
    writeEnabledAgents({
      boris: { enabled: true, org: 'lifeos' },
      paul: { enabled: true, org: 'lifeos' },
    });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeCronsJson('paul', [makeCron('briefing', '24h')]);
    writeExecutionLog('boris', [makeLogEntry('heartbeat', 'fired', now - 1000)]);
    writeExecutionLog('paul', [makeLogEntry('briefing', 'fired', now - 1000)]);

    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth('boris', now);
    expect(result.summary.total).toBe(1);
    expect(result.rows[0].agent).toBe('boris');
  });

  it('skips disabled agents', async () => {
    const now = Date.now();
    writeEnabledAgents({
      boris: { enabled: true, org: 'lifeos' },
      paul: { enabled: false, org: 'lifeos' },
    });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeCronsJson('paul', [makeCron('briefing', '24h')]);

    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.summary.total).toBe(1);
    expect(result.rows[0].agent).toBe('boris');
  });

  it('successRate24h only counts 24h window entries', async () => {
    const now = Date.now();
    const cutoff24h = now - 24 * 3_600_000;
    writeEnabledAgents({ boris: { enabled: true, org: 'lifeos' } });
    writeCronsJson('boris', [makeCron('heartbeat', '6h')]);
    writeExecutionLog('boris', [
      // These are within 24h
      makeLogEntry('heartbeat', 'fired', now - 3_600_000),
      makeLogEntry('heartbeat', 'fired', now - 7_200_000),
      // This is older than 24h — should not count
      makeLogEntry('heartbeat', 'fired', cutoff24h - 1000),
    ]);

    const { computeFleetHealth } = await import('../../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.rows[0].firesLast24h).toBe(2);
  });
});

describe('invalidateFleetHealthCache', () => {
  it('exists as an exported function', async () => {
    const { invalidateFleetHealthCache } = await import('../../../src/daemon/ipc-server');
    expect(typeof invalidateFleetHealthCache).toBe('function');
    // Should not throw
    expect(() => invalidateFleetHealthCache()).not.toThrow();
  });
});
