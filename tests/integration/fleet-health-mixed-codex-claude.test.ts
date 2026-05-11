/**
 * tests/integration/fleet-health-mixed-codex-claude.test.ts — codex peer to
 * fleet-health-mixed-agents.test.ts.
 *
 * Verifies that `computeFleetHealth` is fully runtime-agnostic: codex agents
 * appear in the fleet summary alongside claude agents and produce identical
 * health row shapes. This is the gating contract for the dashboard's mixed
 * agent fleet view (PR 08 added the runtime badge).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition, CronExecutionLogEntry } from '../../src/types/index.js';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const CRONS_DIR = '.cortextOS/state/agents';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-mixed-codex-claude-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>) {
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  writeFileSync(join(tmpRoot, 'config', 'enabled-agents.json'), JSON.stringify(agents, null, 2));
}

function writeCrons(agentName: string, crons: CronDefinition[]) {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeLog(agentName: string, entries: CronExecutionLogEntry[]) {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cron-execution.log'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function cron(name: string, schedule: string): CronDefinition {
  return {
    name,
    prompt: `Run ${name}.`,
    schedule,
    enabled: true,
    created_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  };
}

function entry(cronName: string, status: 'fired' | 'failed', tsMs: number): CronExecutionLogEntry {
  return {
    ts: new Date(tsMs).toISOString(),
    cron: cronName,
    status,
    attempt: 1,
    duration_ms: 100,
    error: status === 'failed' ? 'err' : null,
  };
}

describe('fleet health — codex + claude coexistence', () => {
  it('returns a unified summary across codex and claude agents', async () => {
    const now = Date.now();
    const h = 3_600_000;

    writeEnabledAgents({
      'claude-agent': { enabled: true, org: 'lifeos' },
      'codex-agent':  { enabled: true, org: 'lifeos' },
    });

    writeCrons('claude-agent', [cron('claude-heartbeat', '6h'), cron('claude-report', '24h')]);
    writeLog('claude-agent', [
      entry('claude-heartbeat', 'fired', now - 2 * h),
      entry('claude-report',   'fired', now - 50 * h),
    ]);

    writeCrons('codex-agent', [cron('codex-heartbeat', '6h'), cron('codex-sweep', '1h')]);
    writeLog('codex-agent', [
      entry('codex-heartbeat', 'fired', now - 5 * 60 * 1000),
      entry('codex-sweep',     'failed', now - 30 * 60 * 1000),
    ]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    expect(result.summary.total).toBe(4);

    const rowsByName = new Map(result.rows.map((r) => [r.cronName, r]));
    expect(rowsByName.get('claude-heartbeat')?.state).toBe('healthy');
    expect(rowsByName.get('claude-report')?.state).toBe('warning');
    expect(rowsByName.get('codex-heartbeat')?.state).toBe('healthy');
    expect(rowsByName.get('codex-sweep')?.state).toBe('failure');

    expect(result.summary.agents['codex-agent']).toBeDefined();
    expect(result.summary.agents['codex-agent'].total).toBe(2);
    expect(result.summary.agents['codex-agent'].failure).toBe(1);
    expect(result.summary.agents['claude-agent']).toBeDefined();
    expect(result.summary.agents['claude-agent'].total).toBe(2);
  });

  it('per-agent counts sum to overall totals (mixed runtime)', async () => {
    const now = Date.now();
    const h = 3_600_000;

    writeEnabledAgents({
      'claude-a': { enabled: true, org: 'lifeos' },
      'codex-a':  { enabled: true, org: 'lifeos' },
      'codex-b':  { enabled: true, org: 'testorg' },
    });

    writeCrons('claude-a', [cron('c-a-1', '6h')]);
    writeLog('claude-a', [entry('c-a-1', 'fired', now - 2 * h)]);

    writeCrons('codex-a', [cron('c-x-1', '6h'), cron('c-x-2', '24h')]);
    writeLog('codex-a', [
      entry('c-x-1', 'fired', now - 1 * h),
      // c-x-2 never fired
    ]);

    writeCrons('codex-b', [cron('c-y-1', '1h'), cron('c-y-2', '12h')]);
    writeLog('codex-b', [
      entry('c-y-1', 'failed', now - 60 * 1000),
      entry('c-y-2', 'fired', now - 30 * h), // 30h, 12h sched, 30 > 24 → warning
    ]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    const total = result.summary.healthy + result.summary.warning + result.summary.failure + result.summary.neverFired;
    expect(total).toBe(result.summary.total);
    expect(result.summary.total).toBe(5);

    const codexB = result.summary.agents['codex-b'];
    expect(codexB.total).toBe(2);
    expect(codexB.failure).toBe(1);
    expect(codexB.warning).toBe(1);
  });

  it('cron health row shape is identical for codex and claude agents', async () => {
    const now = Date.now();
    writeEnabledAgents({
      'claude-x': { enabled: true, org: 'lifeos' },
      'codex-x':  { enabled: true, org: 'lifeos' },
    });
    writeCrons('claude-x', [cron('shared-name', '6h')]);
    writeLog('claude-x', [entry('shared-name', 'fired', now - 60_000)]);
    writeCrons('codex-x', [cron('shared-name', '6h')]);
    writeLog('codex-x', [entry('shared-name', 'fired', now - 60_000)]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    const claudeRow = result.rows.find((r) => r.agent === 'claude-x' && r.cronName === 'shared-name')!;
    const codexRow = result.rows.find((r) => r.agent === 'codex-x' && r.cronName === 'shared-name')!;
    expect(Object.keys(claudeRow).sort()).toEqual(Object.keys(codexRow).sort());
    expect(claudeRow.state).toBe(codexRow.state);
    expect(claudeRow.expectedIntervalMs).toBe(codexRow.expectedIntervalMs);
  });
});
