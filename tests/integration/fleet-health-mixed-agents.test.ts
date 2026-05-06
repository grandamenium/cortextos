/**
 * tests/integration/fleet-health-mixed-agents.test.ts — Subtask 4.4
 *
 * Integration test: spin up 3 fake agents with mixed cron states, call
 * computeFleetHealth(), and assert summary numbers match hand-computed expected
 * values.
 *
 * Agent fixture layout:
 *
 *   agent-alpha (org: lifeos)
 *     - alpha-heartbeat (6h)  → fired 2h ago → healthy
 *     - alpha-report (24h)    → fired 50h ago → warning (50h > 2*24h = 48h)
 *
 *   agent-beta (org: cointally)
 *     - beta-task (1h)        → failed 30m ago → failure
 *     - beta-daily (24h)      → never fired → never-fired
 *
 *   agent-gamma (org: lifeos)
 *     - gamma-briefing (4h)   → fired 5m ago → healthy
 *     - gamma-report (6h)     → fired 11h ago → warning (11h > 2*6h = 12h)
 *       wait, 11h < 12h → healthy
 *       Let's use 13h ago → warning
 *
 * Expected counts (hand-computed):
 *   total: 6
 *   healthy: 3  (alpha-heartbeat, gamma-briefing, gamma-report at exactly 13h with 6h sched = 2.17x → warning actually)
 *
 * Let me recalculate carefully:
 *   alpha-heartbeat: gap=2h, interval=6h, 2x=12h → healthy
 *   alpha-report: gap=50h, interval=24h, 2x=48h, 50h > 48h → warning
 *   beta-task: lastStatus=failed → failure
 *   beta-daily: lastFire=null → never-fired
 *   gamma-briefing: gap=5m, interval=4h, 2x=8h → healthy
 *   gamma-report: gap=13h, interval=6h, 2x=12h, 13h > 12h → warning
 *
 * Expected: total=6, healthy=2, warning=2, failure=1, neverFired=1
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
import type { CronDefinition, CronExecutionLogEntry } from '../../src/types/index';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-mixed-integ-'));
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

const CRONS_DIR = '.cortextOS/state/agents';

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>): void {
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'config', 'enabled-agents.json'),
    JSON.stringify(agents, null, 2),
  );
}

function writeCrons(agentName: string, crons: CronDefinition[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeLog(agentName: string, entries: CronExecutionLogEntry[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
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

function entry(
  cronName: string,
  status: 'fired' | 'retried' | 'failed',
  tsMs: number,
): CronExecutionLogEntry {
  return { ts: new Date(tsMs).toISOString(), cron: cronName, status, attempt: 1, duration_ms: 100, error: status === 'failed' ? 'err' : null };
}

describe('computeFleetHealth — 3 agent mixed scenario', () => {
  it('produces hand-computed expected summary: 2 healthy, 2 warning, 1 failure, 1 never-fired', async () => {
    const now = Date.now();
    const h = 3_600_000; // 1 hour in ms

    writeEnabledAgents({
      'agent-alpha': { enabled: true, org: 'lifeos' },
      'agent-beta':  { enabled: true, org: 'cointally' },
      'agent-gamma': { enabled: true, org: 'lifeos' },
    });

    // agent-alpha: heartbeat=healthy, report=warning
    writeCrons('agent-alpha', [cron('alpha-heartbeat', '6h'), cron('alpha-report', '24h')]);
    writeLog('agent-alpha', [
      entry('alpha-heartbeat', 'fired', now - 2 * h),  // 2h ago, 6h sched → healthy
      entry('alpha-report',   'fired', now - 50 * h),  // 50h ago, 24h sched → warning (50 > 48)
    ]);

    // agent-beta: beta-task=failure, beta-daily=never-fired
    writeCrons('agent-beta', [cron('beta-task', '1h'), cron('beta-daily', '24h')]);
    writeLog('agent-beta', [
      entry('beta-task', 'failed', now - 30 * 60 * 1000), // failed 30m ago
      // beta-daily has no log entry
    ]);

    // agent-gamma: briefing=healthy, report=warning
    writeCrons('agent-gamma', [cron('gamma-briefing', '4h'), cron('gamma-report', '6h')]);
    writeLog('agent-gamma', [
      entry('gamma-briefing', 'fired', now - 5 * 60 * 1000),  // 5m ago, 4h sched → healthy
      entry('gamma-report',   'fired', now - 13 * h),          // 13h ago, 6h sched → warning (13 > 12)
    ]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    // Total
    expect(result.summary.total).toBe(6);

    // State counts (hand-computed above)
    expect(result.summary.healthy).toBe(2);   // alpha-heartbeat, gamma-briefing
    expect(result.summary.warning).toBe(2);   // alpha-report, gamma-report
    expect(result.summary.failure).toBe(1);   // beta-task
    expect(result.summary.neverFired).toBe(1); // beta-daily

    // Per-agent breakdown
    expect(result.summary.agents['agent-alpha'].healthy).toBe(1);
    expect(result.summary.agents['agent-alpha'].warning).toBe(1);
    expect(result.summary.agents['agent-beta'].failure).toBe(1);
    expect(result.summary.agents['agent-beta'].neverFired).toBe(1);
    expect(result.summary.agents['agent-gamma'].healthy).toBe(1);
    expect(result.summary.agents['agent-gamma'].warning).toBe(1);

    // Spot check individual rows
    const heartbeat = result.rows.find(r => r.cronName === 'alpha-heartbeat');
    expect(heartbeat?.state).toBe('healthy');
    expect(heartbeat?.agent).toBe('agent-alpha');
    expect(heartbeat?.org).toBe('lifeos');

    const betaDaily = result.rows.find(r => r.cronName === 'beta-daily');
    expect(betaDaily?.state).toBe('never-fired');
    expect(betaDaily?.lastFire).toBeNull();

    const betaTask = result.rows.find(r => r.cronName === 'beta-task');
    expect(betaTask?.state).toBe('failure');
    expect(betaTask?.org).toBe('cointally');
  });

  it('handles 50+ crons across 3 agents without error', async () => {
    const now = Date.now();

    // Build 3 agents each with ~17 crons (total ~51)
    const agents = ['agent-a', 'agent-b', 'agent-c'];
    const enabledMap: Record<string, { enabled: boolean; org: string }> = {};
    for (const a of agents) enabledMap[a] = { enabled: true, org: 'lifeos' };
    writeEnabledAgents(enabledMap);

    for (const agentName of agents) {
      const crons: CronDefinition[] = [];
      const logEntries: CronExecutionLogEntry[] = [];
      for (let i = 0; i < 17; i++) {
        const cronName = `cron-${i}`;
        crons.push({
          name: cronName,
          prompt: `Run ${cronName}.`,
          schedule: '6h',
          enabled: true,
          created_at: new Date(now - 86_400_000).toISOString(),
        });
        // Mix of states
        if (i % 4 === 0) {
          // never-fired: no entry
        } else if (i % 4 === 1) {
          logEntries.push(entry(cronName, 'failed', now - 1000));
        } else if (i % 4 === 2) {
          // warning: fired 15h ago, 6h schedule → 15 > 12 → warning
          logEntries.push(entry(cronName, 'fired', now - 15 * 3_600_000));
        } else {
          // healthy: fired 2h ago
          logEntries.push(entry(cronName, 'fired', now - 2 * 3_600_000));
        }
      }
      writeCrons(agentName, crons);
      writeLog(agentName, logEntries);
    }

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);
    expect(result.summary.total).toBe(51);
    // Sanity: counts sum to total
    const { healthy, warning, failure, neverFired } = result.summary;
    expect(healthy + warning + failure + neverFired).toBe(51);
  });
});
