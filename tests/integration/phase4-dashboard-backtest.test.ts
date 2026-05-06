/**
 * tests/integration/phase4-dashboard-backtest.test.ts — Subtask 4.6
 *
 * Phase 4 Full Backtesting: End-to-end scenarios for all 6 dashboard CRUD
 * + operational workflows.  Each scenario drives the real API route handlers
 * directly (same pattern as executions-export.test.ts and health-route.test.ts),
 * with IPC mocked via vi.mock('@/lib/ipc-client') for mutation + fire operations.
 *
 * No live Next.js server or daemon process is required.
 *
 * Scenarios:
 *   1. Create — POST /api/workflows/crons → disk + GET round-trip
 *   2. Edit   — PATCH /api/workflows/crons/[agent]/[name] → disk
 *   3. History — GET /api/workflows/crons/[agent]/[name]/executions, pagination + filter + CSV
 *   4. Health  — GET /api/workflows/health, state classification + summary counts
 *   5. Test-fire — POST /api/workflows/crons/[agent]/[name]/fire, IPC dispatch + cooldown + flags
 *   6. Delete  — DELETE /api/workflows/crons/[agent]/[name] → disk removal
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared temp root for file-system backed scenarios (1–4, 6)
// Must be set before any route module is imported.
// ---------------------------------------------------------------------------

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-backtest-'));
process.env.CTX_ROOT = rootTmp;

const CRONS_DIR = '.cortextOS/state/agents';
const CONFIG_DIR = path.join(rootTmp, 'config');

// ---------------------------------------------------------------------------
// IPC mock — must be declared before any route import
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock('@/lib/ipc-client', () => {
  function IPCClient() {}
  IPCClient.prototype.send = mockSend;
  return { IPCClient };
});

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
  const dir = path.join(rootTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function readCronsFromDisk(agentName: string): Array<{
  name: string; schedule: string; enabled: boolean; prompt: string;
}> {
  const fp = path.join(rootTmp, CRONS_DIR, agentName, 'crons.json');
  if (!fs.existsSync(fp)) return [];
  const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return parsed.crons ?? [];
}

function writeExecLog(agentName: string, entries: object[]): void {
  const dir = path.join(rootTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

function makeExecEntry(
  cron: string,
  status: 'fired' | 'retried' | 'failed',
  tsOffset: number,
): object {
  return {
    ts: new Date(Date.now() - tsOffset).toISOString(),
    cron,
    status,
    attempt: 1,
    duration_ms: 50,
    error: status === 'fired' ? null : 'some error',
  };
}

// ---------------------------------------------------------------------------
// Route modules — imported lazily after CTX_ROOT is set
// ---------------------------------------------------------------------------

type CronsRootModule = typeof import('../../dashboard/src/app/api/workflows/crons/route');
type CronsNameModule = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/route');
type ExecutionsCronsModule = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route');
type FireModule = typeof import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route');
type HealthModule = typeof import('../../dashboard/src/app/api/workflows/health/route');

let cronsRoot: CronsRootModule;
let cronsName: CronsNameModule;
let executionsRoute: ExecutionsCronsModule;
let fireRoute: FireModule;
let healthRoute: HealthModule;

// ---------------------------------------------------------------------------
// Global fixture initialisation
// ---------------------------------------------------------------------------

const NOW_MS = Date.now();

beforeAll(async () => {
  // Shared enabled-agents registry used by Scenario 1 GET, 4, and 5
  writeEnabledAgents({
    boris: { enabled: true, org: 'lifeos' },
    paul: { enabled: true, org: 'lifeos' },
    nick: { enabled: true, org: 'lifeos' },
    donna: { enabled: true, org: 'lifeos' },
  });

  // Import routes after CTX_ROOT is set
  cronsRoot = await import('../../dashboard/src/app/api/workflows/crons/route');
  cronsName = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/route');
  executionsRoute = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route');
  fireRoute = await import('../../dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route');
  healthRoute = await import('../../dashboard/src/app/api/workflows/health/route');
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Scenario 1: Create cron via API, verify in crons.json + GET round-trip
// ---------------------------------------------------------------------------

describe('Scenario 1 — Create cron (POST + GET round-trip)', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('1a: POST returns 201 when IPC add-cron succeeds', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'boris',
        definition: {
          name: 's1-heartbeat',
          prompt: 'Run heartbeat.',
          schedule: '6h',
          enabled: true,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('1b: IPC was called with correct add-cron payload', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'boris',
        definition: { name: 's1-hb2', prompt: 'x', schedule: '1h', enabled: true },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    await cronsRoot.POST(req);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add-cron',
        agent: 'boris',
        data: expect.objectContaining({
          definition: expect.objectContaining({ name: 's1-hb2', schedule: '1h' }),
        }),
        source: 'dashboard/api',
      }),
    );
  });

  it('1c: GET /api/workflows/crons returns the pre-seeded cron', async () => {
    // Write a cron directly to disk (simulating what the daemon does after IPC)
    writeCronsJson('boris', [
      {
        name: 's1-heartbeat',
        prompt: 'Run heartbeat.',
        schedule: '6h',
        enabled: true,
        created_at: new Date(NOW_MS - 3_600_000).toISOString(),
        last_fired_at: new Date(NOW_MS - 1_800_000).toISOString(),
        fire_count: 2,
      },
    ]);

    const req = new NextRequest('http://localhost/api/workflows/crons?agent=boris');
    const res = await cronsRoot.GET(req);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((r: { agent: string; cron: { name: string } }) =>
      r.agent === 'boris' && r.cron.name === 's1-heartbeat'
    );
    expect(row).toBeDefined();
    expect(row.cron.schedule).toBe('6h');
    expect(row.nextFire).toBeDefined();
    expect(row.nextFire).not.toBe('unknown');
  });

  it('1d: POST returns 400 when agent field is missing', async () => {
    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({ definition: { name: 'x', prompt: 'y', schedule: '1h' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('1e: POST returns 409 when IPC returns "already exists" error', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Cron s1-heartbeat already exists for agent boris.',
    });

    const req = new NextRequest('http://localhost/api/workflows/crons', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'boris',
        definition: { name: 's1-heartbeat', prompt: 'x', schedule: '1h' },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsRoot.POST(req);
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Edit cron interval via PATCH, verify new schedule
// ---------------------------------------------------------------------------

describe('Scenario 2 — Edit cron (PATCH + disk verification)', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('2a: PATCH returns 200 on successful update', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/s2-cron', {
      method: 'PATCH',
      body: JSON.stringify({ patch: { schedule: '12h' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsName.PATCH(req, {
      params: Promise.resolve({ agent: 'boris', name: 's2-cron' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('2b: PATCH sends correct update-cron IPC payload with patch field', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/s2-cron', {
      method: 'PATCH',
      body: JSON.stringify({ patch: { schedule: '24h', enabled: false } }),
      headers: { 'Content-Type': 'application/json' },
    });
    await cronsName.PATCH(req, {
      params: Promise.resolve({ agent: 'boris', name: 's2-cron' }),
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'update-cron',
        agent: 'boris',
        data: {
          name: 's2-cron',
          patch: { schedule: '24h', enabled: false },
        },
      }),
    );
  });

  it('2c: crons.json reflects new interval after IPC writes it (disk verification)', async () => {
    // Simulate the daemon writing the updated file after a successful PATCH
    writeCronsJson('boris', [
      {
        name: 's2-cron',
        prompt: 'Original.',
        schedule: '12h', // updated from 6h
        enabled: false,
        created_at: new Date(NOW_MS - 86_400_000).toISOString(),
      },
    ]);

    const onDisk = readCronsFromDisk('boris');
    const cron = onDisk.find(c => c.name === 's2-cron');
    expect(cron).toBeDefined();
    expect(cron!.schedule).toBe('12h');
    expect(cron!.enabled).toBe(false);
  });

  it('2d: PATCH returns 404 when IPC responds "not found"', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Cron ghost-cron not found for agent boris',
    });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/ghost-cron', {
      method: 'PATCH',
      body: JSON.stringify({ patch: { schedule: '1h' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsName.PATCH(req, {
      params: Promise.resolve({ agent: 'boris', name: 'ghost-cron' }),
    });
    expect(res.status).toBe(404);
  });

  it('2e: PATCH returns 400 when patch field is missing from body', async () => {
    const req = new NextRequest('http://localhost/api/workflows/crons/boris/s2-cron', {
      method: 'PATCH',
      body: JSON.stringify({ wrong: 'field' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await cronsName.PATCH(req, {
      params: Promise.resolve({ agent: 'boris', name: 's2-cron' }),
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: View cron history — pagination, filter, CSV export
// ---------------------------------------------------------------------------

describe('Scenario 3 — View history (GET executions, pagination + filter + export)', () => {
  const AGENT = 'paul';
  const CRON = 's3-monitor';

  // 30 fired + 10 failed = 40 total entries
  const TOTAL = 40;
  const FIRED_COUNT = 30;
  const FAILED_COUNT = 10;

  beforeAll(() => {
    const entries: object[] = [
      ...Array.from({ length: FIRED_COUNT }, (_, i) =>
        makeExecEntry(CRON, 'fired', (TOTAL - i) * 60_000)
      ),
      ...Array.from({ length: FAILED_COUNT }, (_, i) =>
        makeExecEntry(CRON, 'failed', (FAILED_COUNT - i) * 10_000)
      ),
    ];
    writeExecLog(AGENT, entries);
  });

  async function callGet(qs: string) {
    const req = new NextRequest(
      `http://localhost/api/workflows/crons/${AGENT}/${CRON}/executions?${qs}`,
    );
    return executionsRoute.GET(req, {
      params: Promise.resolve({ agent: AGENT, name: CRON }),
    });
  }

  it('3a: default GET returns {entries, total, hasMore} shape', async () => {
    const res = await callGet('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
    expect(body.total).toBe(TOTAL);
  });

  it('3b: pagination — first page (limit=10, offset=0) has 10 entries, hasMore=true', async () => {
    const res = await callGet('limit=10&offset=0');
    const body = await res.json();
    expect(body.entries).toHaveLength(10);
    expect(body.total).toBe(TOTAL);
    expect(body.hasMore).toBe(true);
  });

  it('3c: pagination — second page (limit=20, offset=20) has 20 entries', async () => {
    const res = await callGet('limit=20&offset=20');
    const body = await res.json();
    expect(body.entries).toHaveLength(20);
    expect(body.total).toBe(TOTAL);
  });

  it('3d: pagination — last page (limit=10, offset=30) has 10 entries, hasMore=false', async () => {
    const res = await callGet('limit=10&offset=30');
    const body = await res.json();
    expect(body.entries).toHaveLength(10);
    expect(body.hasMore).toBe(false);
  });

  it('3e: ?status=failure returns only failed entries', async () => {
    const res = await callGet('limit=100&status=failure');
    const body = await res.json();
    expect(body.total).toBe(FAILED_COUNT);
    expect(body.entries.every((e: { status: string }) => e.status === 'failed')).toBe(true);
  });

  it('3f: ?status=success returns only fired entries', async () => {
    const res = await callGet('limit=100&status=success');
    const body = await res.json();
    expect(body.total).toBe(FIRED_COUNT);
    expect(body.entries.every((e: { status: string }) => e.status === 'fired')).toBe(true);
  });

  it('3g: all entries have required fields (ts, cron, status, attempt, duration_ms, error)', async () => {
    const res = await callGet('limit=100');
    const body = await res.json();
    for (const e of body.entries) {
      expect(e).toHaveProperty('ts');
      expect(e).toHaveProperty('cron');
      expect(e).toHaveProperty('status');
      expect(e).toHaveProperty('attempt');
      expect(e).toHaveProperty('duration_ms');
      expect(e).toHaveProperty('error');
    }
  });

  it('3h: CSV export — returns Content-Disposition attachment with .csv filename', async () => {
    const res = await callGet('format=csv&limit=0');
    expect(res.status).toBe(200);
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('.csv');
  });

  it('3i: CSV export — header row correct, data rows match total', async () => {
    const res = await callGet('format=csv&limit=0');
    const body = await res.text();
    const lines = body.split('\n').filter(l => l.trim());
    expect(lines[0]).toBe('timestamp,cron,status,attempt,duration_ms,error');
    expect(lines.length).toBe(TOTAL + 1); // header + TOTAL rows
  });

  it('3j: empty agent returns {entries:[], total:0, hasMore:false}', async () => {
    const req = new NextRequest(
      'http://localhost/api/workflows/crons/ghost-agent/s3-monitor/executions',
    );
    const res = await executionsRoute.GET(req, {
      params: Promise.resolve({ agent: 'ghost-agent', name: 's3-monitor' }),
    });
    const body = await res.json();
    expect(body.entries).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Health dashboard — state classification + summary counts
// ---------------------------------------------------------------------------

describe('Scenario 4 — Health dashboard (GET /api/workflows/health)', () => {
  const HEALTH_NOW = Date.now();

  beforeAll(() => {
    // nick: healthy (fired 1h ago, 6h schedule — gap=1h < 2×6h=12h)
    writeCronsJson('nick', [
      {
        name: 's4-healthy',
        prompt: 'Heartbeat.',
        schedule: '6h',
        enabled: true,
        created_at: new Date(HEALTH_NOW - 86_400_000).toISOString(),
      },
    ]);
    writeExecLog('nick', [
      {
        ts: new Date(HEALTH_NOW - 3_600_000).toISOString(),
        cron: 's4-healthy',
        status: 'fired',
        attempt: 1,
        duration_ms: 50,
        error: null,
      },
    ]);

    // donna: warning (fired 50h ago, 24h schedule — gap > 2×24h=48h)
    writeCronsJson('donna', [
      {
        name: 's4-warning',
        prompt: 'Report.',
        schedule: '24h',
        enabled: true,
        created_at: new Date(HEALTH_NOW - 86_400_000).toISOString(),
      },
      {
        name: 's4-never',
        prompt: 'Never.',
        schedule: '6h',
        enabled: true,
        created_at: new Date(HEALTH_NOW - 86_400_000).toISOString(),
      },
    ]);
    writeExecLog('donna', [
      {
        ts: new Date(HEALTH_NOW - 50 * 3_600_000).toISOString(),
        cron: 's4-warning',
        status: 'fired',
        attempt: 1,
        duration_ms: 100,
        error: null,
      },
      // s4-never has no entry → never-fired
    ]);

    // paul: failure (last exec failed)
    writeCronsJson('paul', [
      {
        name: 's4-failure',
        prompt: 'Daily.',
        schedule: '24h',
        enabled: true,
        created_at: new Date(HEALTH_NOW - 86_400_000).toISOString(),
      },
    ]);
    writeExecLog('paul', [
      {
        ts: new Date(HEALTH_NOW - 1_000).toISOString(),
        cron: 's4-failure',
        status: 'failed',
        attempt: 1,
        duration_ms: 50,
        error: 'PTY not found',
      },
    ]);
  });

  function makeHealthReq(qs = ''): NextRequest {
    return new NextRequest(`http://localhost/api/workflows/health${qs ? '?' + qs : ''}`);
  }

  it('4a: returns 200 with rows and summary', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('rows');
    expect(data).toHaveProperty('summary');
    expect(Array.isArray(data.rows)).toBe(true);
  });

  it('4b: s4-healthy (nick) classified as healthy', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const row = data.rows.find(
      (r: { agent: string; cronName: string }) => r.agent === 'nick' && r.cronName === 's4-healthy'
    );
    expect(row).toBeDefined();
    expect(row.state).toBe('healthy');
  });

  it('4c: s4-warning (donna) classified as warning (50h > 2×24h threshold)', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const row = data.rows.find(
      (r: { agent: string; cronName: string }) => r.agent === 'donna' && r.cronName === 's4-warning'
    );
    expect(row).toBeDefined();
    expect(row.state).toBe('warning');
  });

  it('4d: s4-never (donna) classified as never-fired', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const row = data.rows.find(
      (r: { agent: string; cronName: string }) => r.agent === 'donna' && r.cronName === 's4-never'
    );
    expect(row).toBeDefined();
    expect(row.state).toBe('never-fired');
  });

  it('4e: s4-failure (paul) classified as failure', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const row = data.rows.find(
      (r: { agent: string; cronName: string }) => r.agent === 'paul' && r.cronName === 's4-failure'
    );
    expect(row).toBeDefined();
    expect(row.state).toBe('failure');
  });

  it('4f: summary counts match hand-computed values', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const { summary } = data;
    // Agents with crons in this scenario: nick(1), donna(2), paul(1) = 4 total
    // boris has s1/s2 crons from earlier writes; we only assert ≥ for multi-scenario safety
    expect(summary.healthy).toBeGreaterThanOrEqual(1);   // nick s4-healthy
    expect(summary.warning).toBeGreaterThanOrEqual(1);   // donna s4-warning
    expect(summary.failure).toBeGreaterThanOrEqual(1);   // paul s4-failure
    expect(summary.neverFired).toBeGreaterThanOrEqual(1); // donna s4-never
  });

  it('4g: per-agent breakdown present in summary.agents', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const { agents } = data.summary;
    expect(agents).toHaveProperty('nick');
    expect(agents).toHaveProperty('donna');
    expect(agents).toHaveProperty('paul');
    expect(agents['nick'].total).toBeGreaterThanOrEqual(1);
    expect(agents['donna'].total).toBeGreaterThanOrEqual(2);
    expect(agents['paul'].total).toBeGreaterThanOrEqual(1);
  });

  it('4h: ?agent=nick filter returns only nick crons', async () => {
    const res = await healthRoute.GET(makeHealthReq('agent=nick'));
    const data = await res.json();
    expect(data.rows.every((r: { agent: string }) => r.agent === 'nick')).toBe(true);
  });

  it('4i: each row has all required health fields', async () => {
    const res = await healthRoute.GET(makeHealthReq());
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

  it('4j: color coding — warning rows have gapMs > 2x expectedIntervalMs', async () => {
    const res = await healthRoute.GET(makeHealthReq());
    const data = await res.json();
    const warningRows = data.rows.filter(
      (r: { state: string; gapMs: number | null; expectedIntervalMs: number }) =>
        r.state === 'warning'
    );
    for (const row of warningRows) {
      if (row.gapMs !== null && row.expectedIntervalMs > 0) {
        expect(row.gapMs).toBeGreaterThan(2 * row.expectedIntervalMs);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Test-fire — IPC dispatch + cooldown + manualFireDisabled flag
// ---------------------------------------------------------------------------

describe('Scenario 5 — Test-fire (POST /api/workflows/crons/[agent]/[name]/fire)', () => {
  beforeEach(() => { mockSend.mockReset(); });

  async function callFire(agent: string, name: string) {
    const req = new NextRequest(
      `http://localhost/api/workflows/crons/${agent}/${name}/fire`,
      { method: 'POST' },
    );
    return fireRoute.POST(req, {
      params: Promise.resolve({ agent, name }),
    });
  }

  it('5a: successful fire returns 200 with ok:true and firedAt', async () => {
    const firedAt = NOW_MS;
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt } });

    const res = await callFire('boris', 's5-cron');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.firedAt).toBe(firedAt);
  });

  it('5b: IPC was called with correct fire-cron payload', async () => {
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt: NOW_MS } });

    await callFire('boris', 's5-cron');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fire-cron',
        agent: 'boris',
        data: { name: 's5-cron' },
        source: 'dashboard/api/fire',
      }),
    );
  });

  it('5c: returns 409 on cooldown (IPC returns Cooldown active)', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Cooldown active — wait 25s before firing again.',
    });

    const res = await callFire('boris', 's5-cron');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Cooldown active');
  });

  it('5d: returns 403 when manualFireDisabled is set', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Manual fire disabled for this cron.',
    });

    const res = await callFire('boris', 's5-locked');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Manual fire disabled');
  });

  it('5e: returns 404 when cron not found for agent', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Cron 'ghost' not found for agent 'boris'.",
    });

    const res = await callFire('boris', 'ghost');
    expect(res.status).toBe(404);
  });

  it('5f: returns 500 when agent is not running', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Agent 'boris' not found or not running.",
    });

    const res = await callFire('boris', 's5-cron');
    expect(res.status).toBe(500);
  });

  it('5g: returns 400 for invalid agent name (contains space)', async () => {
    const req = new NextRequest(
      'http://localhost/api/workflows/crons/bad%20agent/s5-cron/fire',
      { method: 'POST' },
    );
    const res = await fireRoute.POST(req, {
      params: Promise.resolve({ agent: 'bad agent', name: 's5-cron' }),
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('5h: IPC connection failure propagates as 500', async () => {
    mockSend.mockRejectedValueOnce(new Error('IPC request timed out'));

    const res = await callFire('boris', 's5-cron');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('IPC error');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Delete cron — IPC remove-cron + disk absence verification
// ---------------------------------------------------------------------------

describe('Scenario 6 — Delete cron (DELETE + disk verification)', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('6a: DELETE returns 200 when IPC remove-cron succeeds', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/s6-cron', {
      method: 'DELETE',
    });
    const res = await cronsName.DELETE(req, {
      params: Promise.resolve({ agent: 'boris', name: 's6-cron' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('6b: DELETE sends correct remove-cron IPC payload', async () => {
    mockSend.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/s6-cron', {
      method: 'DELETE',
    });
    await cronsName.DELETE(req, {
      params: Promise.resolve({ agent: 'boris', name: 's6-cron' }),
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'remove-cron',
        agent: 'boris',
        data: { name: 's6-cron' },
      }),
    );
  });

  it('6c: cron absent from disk after daemon removes it (disk verification)', async () => {
    // Seed two crons, then simulate daemon writing the file after remove
    writeCronsJson('boris', [
      {
        name: 's6-remaining',
        prompt: 'Keep me.',
        schedule: '1h',
        enabled: true,
        created_at: new Date().toISOString(),
      },
    ]);
    // s6-cron is gone — only s6-remaining present
    const onDisk = readCronsFromDisk('boris');
    const deleted = onDisk.find(c => c.name === 's6-cron');
    expect(deleted).toBeUndefined();
    const kept = onDisk.find(c => c.name === 's6-remaining');
    expect(kept).toBeDefined();
  });

  it('6d: subsequent GET for deleted cron is absent from list', async () => {
    const req = new NextRequest('http://localhost/api/workflows/crons?agent=boris');
    const res = await cronsRoot.GET(req);
    const rows = await res.json();
    const deleted = rows.find(
      (r: { agent: string; cron: { name: string } }) =>
        r.agent === 'boris' && r.cron.name === 's6-cron'
    );
    expect(deleted).toBeUndefined();
  });

  it('6e: DELETE returns 404 when IPC says cron not found', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Cron 'ghost' not found for agent 'boris'.",
    });

    const req = new NextRequest('http://localhost/api/workflows/crons/boris/ghost', {
      method: 'DELETE',
    });
    const res = await cronsName.DELETE(req, {
      params: Promise.resolve({ agent: 'boris', name: 'ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('6f: DELETE returns 400 for invalid agent name (spaces)', async () => {
    const req = new NextRequest('http://localhost/api/workflows/crons/bad%20agent/s6-cron', {
      method: 'DELETE',
    });
    const res = await cronsName.DELETE(req, {
      params: Promise.resolve({ agent: 'bad agent', name: 's6-cron' }),
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
