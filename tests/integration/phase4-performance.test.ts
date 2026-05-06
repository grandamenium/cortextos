/**
 * tests/integration/phase4-performance.test.ts — Subtask 4.6
 *
 * Performance benchmarks for the external cron dashboard API routes.
 *
 * Measures:
 *   - GET /api/workflows/crons (50-cron and 100-cron datasets) — p50 + p95
 *   - GET /api/workflows/health (50-cron and 100-cron datasets) — p50 + p95
 *   - GET /api/workflows/crons/[agent]/[name]/executions with 1000-entry log — p50 + p95
 *
 * Success criteria: all p95 < 2000ms
 *
 * Each measurement runs 10 iterations; the median (p50) and 95th percentile
 * are computed from the sorted sample.
 *
 * Note: These tests measure route handler execution time (Node.js process,
 * real disk I/O to a tmp dir on the OS default tmpfs/disk). Results are
 * representative of server-side latency excluding network overhead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Temp root — separate from the backtest root to avoid cross-contamination
// ---------------------------------------------------------------------------

const perfTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-perf-'));
process.env.CTX_ROOT = perfTmp;

const CRONS_DIR = '.cortextOS/state/agents';
const CONFIG_DIR = path.join(perfTmp, 'config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG_DIR, 'enabled-agents.json'),
    JSON.stringify(agents, null, 2),
  );
}

function writeCronsJson(agentName: string, crons: object[]): void {
  const dir = path.join(perfTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeExecLog(agentName: string, entries: object[]): void {
  const dir = path.join(perfTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

function makeCron(agentName: string, cronIdx: number, now: number): object {
  const schedules = ['6h', '24h', '1h', '12h', '0 9 * * *'];
  const schedule = schedules[cronIdx % schedules.length];
  const lastFiredHoursAgo = (cronIdx % 24) + 1;
  return {
    name: `perf-cron-${agentName}-${cronIdx}`,
    prompt: `Performance cron ${cronIdx} for ${agentName}`,
    schedule,
    enabled: true,
    created_at: new Date(now - 7 * 86_400_000).toISOString(),
    last_fired_at: new Date(now - lastFiredHoursAgo * 3_600_000).toISOString(),
    fire_count: cronIdx * 3 + 1,
  };
}

function makeExecEntries(cronName: string, count: number, now: number): object[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(now - (count - i) * 60_000).toISOString(),
    cron: cronName,
    status: i % 10 === 0 ? 'failed' : 'fired',
    attempt: 1,
    duration_ms: 40 + (i % 60),
    error: i % 10 === 0 ? 'simulated failure' : null,
  }));
}

/** Compute percentile from sorted array (0-based, linear interpolation). */
function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = (p / 100) * (sortedMs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedMs[lo];
  return sortedMs[lo] + (sortedMs[hi] - sortedMs[lo]) * (idx - lo);
}

/** Run `fn` `iterations` times and return sorted wall-time samples (ms). */
async function bench(fn: () => Promise<unknown>, iterations = 10): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Dataset construction
// ---------------------------------------------------------------------------

const NOW_MS = Date.now();

// 50 crons across 5 agents (10 each)
const AGENTS_50 = ['perf-a1', 'perf-a2', 'perf-a3', 'perf-a4', 'perf-a5'];
// 100 crons across 10 agents (10 each)
const AGENTS_100 = [
  'perf-b1', 'perf-b2', 'perf-b3', 'perf-b4', 'perf-b5',
  'perf-b6', 'perf-b7', 'perf-b8', 'perf-b9', 'perf-b10',
];
// 1000 log entries per cron (5 representative crons in the 100-cron set)
const HEAVY_LOG_AGENTS = ['perf-b1', 'perf-b2', 'perf-b3', 'perf-b4', 'perf-b5'];

let cronsRootModule: typeof import('../../dashboard/src/app/api/workflows/crons/route');
let healthModule: typeof import('../../dashboard/src/app/api/workflows/health/route');
let execModule: typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route');

beforeAll(async () => {
  const allAgents: Record<string, { enabled: boolean; org: string }> = {};
  [...AGENTS_50, ...AGENTS_100].forEach(a => {
    allAgents[a] = { enabled: true, org: 'lifeos' };
  });
  writeEnabledAgents(allAgents);

  // 50-cron dataset: 5 agents × 10 crons
  for (const agent of AGENTS_50) {
    const crons = Array.from({ length: 10 }, (_, i) => makeCron(agent, i, NOW_MS));
    writeCronsJson(agent, crons);
    // Sparse exec log: 5 entries per cron
    const entries: object[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(...makeExecEntries(`perf-cron-${agent}-${i}`, 5, NOW_MS));
    }
    writeExecLog(agent, entries);
  }

  // 100-cron dataset: 10 agents × 10 crons
  for (const agent of AGENTS_100) {
    const crons = Array.from({ length: 10 }, (_, i) => makeCron(agent, i, NOW_MS));
    writeCronsJson(agent, crons);

    if (HEAVY_LOG_AGENTS.includes(agent)) {
      // Heavy log: 1000 entries per cron (10 crons × 1000 = 10,000 entries per agent)
      const entries: object[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push(...makeExecEntries(`perf-cron-${agent}-${i}`, 1000, NOW_MS));
      }
      writeExecLog(agent, entries);
    } else {
      // Sparse: 5 entries per cron
      const entries: object[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push(...makeExecEntries(`perf-cron-${agent}-${i}`, 5, NOW_MS));
      }
      writeExecLog(agent, entries);
    }
  }

  cronsRootModule = await import('../../dashboard/src/app/api/workflows/crons/route');
  healthModule = await import('../../dashboard/src/app/api/workflows/health/route');
  execModule = await import(
    '../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route'
  );
});

afterAll(() => {
  try { fs.rmSync(perfTmp, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Stored results for the report
// ---------------------------------------------------------------------------

const perfResults: Record<string, { p50: number; p95: number; count: number }> = {};

// ---------------------------------------------------------------------------
// GET /api/workflows/crons — 50-cron dataset
// ---------------------------------------------------------------------------

describe('Perf: GET /api/workflows/crons — 50 crons (5 agents)', () => {
  it('p95 < 2000ms', async () => {
    const samples = await bench(async () => {
      const req = new NextRequest('http://localhost/api/workflows/crons');
      const res = await cronsRootModule.GET(req);
      // Consume body to include serialization in the measurement
      await res.json();
    }, 10);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    perfResults['crons-50'] = { p50, p95, count: 50 };

    console.log(
      `[perf] GET /crons (50 crons): ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/crons — 100-cron dataset
// ---------------------------------------------------------------------------

describe('Perf: GET /api/workflows/crons — 100 crons (10 agents)', () => {
  it('p95 < 2000ms', async () => {
    const samples = await bench(async () => {
      const req = new NextRequest('http://localhost/api/workflows/crons');
      const res = await cronsRootModule.GET(req);
      await res.json();
    }, 10);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    perfResults['crons-100'] = { p50, p95, count: 100 };

    console.log(
      `[perf] GET /crons (100 crons): ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/health — 50-cron dataset
// ---------------------------------------------------------------------------

describe('Perf: GET /api/workflows/health — 50 crons', () => {
  it('p95 < 2000ms', async () => {
    const samples = await bench(async () => {
      const req = new NextRequest('http://localhost/api/workflows/health');
      const res = await healthModule.GET(req);
      await res.json();
    }, 10);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    perfResults['health-50'] = { p50, p95, count: 50 };

    console.log(
      `[perf] GET /health (50 crons): ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/health — 100-cron dataset (with heavy logs)
// ---------------------------------------------------------------------------

describe('Perf: GET /api/workflows/health — 100 crons + heavy logs', () => {
  it('p95 < 2000ms', async () => {
    const samples = await bench(async () => {
      const req = new NextRequest('http://localhost/api/workflows/health');
      const res = await healthModule.GET(req);
      await res.json();
    }, 10);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    perfResults['health-100-heavy'] = { p50, p95, count: 100 };

    console.log(
      `[perf] GET /health (100 crons + heavy logs): ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/crons/[agent]/[name]/executions — 1000-entry log
// ---------------------------------------------------------------------------

describe('Perf: GET executions — 1000-entry log', () => {
  it('p95 < 2000ms', async () => {
    const agent = 'perf-b1';
    const cronName = `perf-cron-${agent}-0`;

    const samples = await bench(async () => {
      const req = new NextRequest(
        `http://localhost/api/workflows/crons/${agent}/${cronName}/executions?limit=100`,
      );
      const res = await execModule.GET(req, {
        params: Promise.resolve({ agent, name: cronName }),
      });
      await res.json();
    }, 10);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    perfResults['executions-1000'] = { p50, p95, count: 1000 };

    console.log(
      `[perf] GET /executions (1000 entries): ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Summary assertion — all p95s < 2000ms
// ---------------------------------------------------------------------------

describe('Perf: all p95 < 2000ms (summary)', () => {
  it('reports accumulated results', () => {
    console.log('\n=== Phase 4 Performance Summary ===');
    for (const [key, { p50, p95, count }] of Object.entries(perfResults)) {
      const pass = p95 < 2000 ? 'PASS' : 'FAIL';
      console.log(
        `  ${pass}  ${key.padEnd(24)} ${count} crons  ` +
        `p50=${p50.toFixed(1).padStart(7)}ms  p95=${p95.toFixed(1).padStart(7)}ms`,
      );
    }
    console.log('====================================\n');

    // All p95s should be < 2000ms
    for (const [key, { p95 }] of Object.entries(perfResults)) {
      expect(p95, `${key} p95 must be < 2000ms`).toBeLessThan(2000);
    }
  });
});
