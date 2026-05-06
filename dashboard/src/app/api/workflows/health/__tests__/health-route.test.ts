/**
 * dashboard/src/app/api/workflows/health/__tests__/health-route.test.ts
 * — Subtask 4.4
 *
 * API route tests for GET /api/workflows/health:
 *   - Response shape: {rows, summary} with correct counts
 *   - ?agent= filter
 *   - State classification: healthy / warning / failure / never-fired
 *   - Empty state: no crons configured
 *
 * Uses the route handler directly with mocked filesystem (CTX_ROOT set before import).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-route-test-'));
process.env.CTX_ROOT = rootTmp;

const CRONS_DIR = '.cortextOS/state/agents';
const CONFIG_DIR = path.join(rootTmp, 'config');

const NOW_MS = Date.now();

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG_DIR, 'enabled-agents.json'),
    JSON.stringify(agents, null, 2),
  );
}

function writeCronsJson(agentName: string, crons: object[]): void {
  const dir = path.join(rootTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeExecLog(agentName: string, entries: object[]): void {
  const dir = path.join(rootTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

// Build fixture data before importing the route (CTX_ROOT must be set first)
beforeAll(() => {
  // boris: healthy cron (fired 1h ago, 6h schedule)
  writeEnabledAgents({
    boris: { enabled: true, org: 'lifeos' },
    paul: { enabled: true, org: 'lifeos' },
    nick: { enabled: true, org: 'cointally' },
  });

  writeCronsJson('boris', [
    {
      name: 'heartbeat',
      prompt: 'Do heartbeat.',
      schedule: '6h',
      enabled: true,
      created_at: new Date(NOW_MS - 86_400_000).toISOString(),
    },
  ]);
  writeExecLog('boris', [
    { ts: new Date(NOW_MS - 3_600_000).toISOString(), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 100, error: null },
  ]);

  // paul: warning cron (fired 50h ago, 24h schedule → 2x = 48h → warning)
  writeCronsJson('paul', [
    {
      name: 'morning-briefing',
      prompt: 'Do briefing.',
      schedule: '24h',
      enabled: true,
      created_at: new Date(NOW_MS - 86_400_000).toISOString(),
    },
  ]);
  writeExecLog('paul', [
    { ts: new Date(NOW_MS - 50 * 3_600_000).toISOString(), cron: 'morning-briefing', status: 'fired', attempt: 1, duration_ms: 200, error: null },
  ]);

  // nick: failure cron
  writeCronsJson('nick', [
    {
      name: 'daily-report',
      prompt: 'Report.',
      schedule: '24h',
      enabled: true,
      created_at: new Date(NOW_MS - 86_400_000).toISOString(),
    },
    {
      name: 'never-run',
      prompt: 'Never.',
      schedule: '6h',
      enabled: true,
      created_at: new Date(NOW_MS - 86_400_000).toISOString(),
    },
  ]);
  writeExecLog('nick', [
    { ts: new Date(NOW_MS - 1_000).toISOString(), cron: 'daily-report', status: 'failed', attempt: 1, duration_ms: 50, error: 'oops' },
    // never-run has no entry
  ]);
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Import route after fixture setup
// ---------------------------------------------------------------------------

// Dynamic import to ensure CTX_ROOT is set before module init
let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  const mod = await import('../route');
  GET = mod.GET;
});

function makeReq(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/workflows/health${search ? '?' + search : ''}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/workflows/health', () => {
  it('returns 200 with rows and summary', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('rows');
    expect(data).toHaveProperty('summary');
    expect(Array.isArray(data.rows)).toBe(true);
  });

  it('summary total matches total crons across all agents', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    // boris: 1 + paul: 1 + nick: 2 = 4
    expect(data.summary.total).toBe(4);
    expect(data.rows).toHaveLength(4);
  });

  it('correctly classifies healthy cron (boris heartbeat)', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const row = data.rows.find((r: { agent: string; cronName: string }) => r.agent === 'boris' && r.cronName === 'heartbeat');
    expect(row).toBeDefined();
    expect(row.state).toBe('healthy');
  });

  it('correctly classifies warning cron (paul morning-briefing > 2x interval)', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const row = data.rows.find((r: { agent: string; cronName: string }) => r.agent === 'paul' && r.cronName === 'morning-briefing');
    expect(row).toBeDefined();
    expect(row.state).toBe('warning');
  });

  it('correctly classifies failure cron (nick daily-report)', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const row = data.rows.find((r: { agent: string; cronName: string }) => r.agent === 'nick' && r.cronName === 'daily-report');
    expect(row).toBeDefined();
    expect(row.state).toBe('failure');
  });

  it('correctly classifies never-fired cron (nick never-run)', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const row = data.rows.find((r: { agent: string; cronName: string }) => r.agent === 'nick' && r.cronName === 'never-run');
    expect(row).toBeDefined();
    expect(row.state).toBe('never-fired');
  });

  it('summary counts match per-state classification', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const { summary } = data;
    expect(summary.healthy).toBe(1);    // boris heartbeat
    expect(summary.warning).toBe(1);    // paul morning-briefing
    expect(summary.failure).toBe(1);    // nick daily-report
    expect(summary.neverFired).toBe(1); // nick never-run
  });

  it('?agent= filter returns only that agent', async () => {
    const res = await GET(makeReq('agent=boris'));
    const data = await res.json();
    expect(data.summary.total).toBe(1);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].agent).toBe('boris');
  });

  it('?agent= filter with unknown agent returns empty', async () => {
    const res = await GET(makeReq('agent=nonexistent'));
    const data = await res.json();
    expect(data.summary.total).toBe(0);
    expect(data.rows).toHaveLength(0);
  });

  it('summary.agents contains per-agent breakdown', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    const { agents } = data.summary;
    expect(agents).toHaveProperty('boris');
    expect(agents).toHaveProperty('paul');
    expect(agents).toHaveProperty('nick');
    expect(agents['boris'].total).toBe(1);
    expect(agents['paul'].total).toBe(1);
    expect(agents['nick'].total).toBe(2);
  });

  it('rows contain all required fields', async () => {
    const res = await GET(makeReq());
    const data = await res.json();
    for (const row of data.rows) {
      expect(row).toHaveProperty('agent');
      expect(row).toHaveProperty('org');
      expect(row).toHaveProperty('cronName');
      expect(row).toHaveProperty('state');
      expect(row).toHaveProperty('reason');
      expect(row).toHaveProperty('lastFire');
      expect(row).toHaveProperty('expectedIntervalMs');
      expect(row).toHaveProperty('gapMs');
      expect(row).toHaveProperty('successRate24h');
      expect(row).toHaveProperty('firesLast24h');
      expect(row).toHaveProperty('nextFire');
    }
  });
});
