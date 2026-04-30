/**
 * dashboard/src/app/api/workflows/crons/__tests__/executions-export.test.ts
 * — Subtask 4.3
 *
 * API route tests for /api/workflows/crons/[agent]/executions:
 *   - pagination response shape {entries, total, hasMore}
 *   - ?format=csv → Content-Disposition + CSV body
 *   - ?format=json-download → Content-Disposition + JSON body
 *   - ?status=success|failure filter
 *   - 400 on invalid agent name
 *
 * Uses the route helper functions directly (no HTTP server).
 * CTX_ROOT is set before import so the route picks up the temp path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import type { CronExecutionLogEntry } from '../../../../../../../src/types/index';

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-export-test-'));
process.env.CTX_ROOT = rootTmp;

const CRONS_DIR = '.cortextOS/state/agents';
const AGENT = 'boris';
const CRON_NAME = 'heartbeat';

function makeEntry(
  cronName: string,
  status: 'fired' | 'retried' | 'failed',
  idx: number,
): CronExecutionLogEntry {
  return {
    ts: new Date(1_000_000 + idx * 1_000).toISOString(),
    cron: cronName,
    status,
    attempt: 1,
    duration_ms: idx,
    error: status === 'fired' ? null : `err:${idx}`,
  };
}

function writeLog(agentName: string, entries: CronExecutionLogEntry[]): void {
  const dir = path.join(rootTmp, CRONS_DIR, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cron-execution.log'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

// Write 10 fired + 5 failed for the test agent
beforeAll(() => {
  const entries: CronExecutionLogEntry[] = [
    ...Array.from({ length: 10 }, (_, i) => makeEntry(CRON_NAME, 'fired', i)),
    ...Array.from({ length: 5 }, (_, i) => makeEntry(CRON_NAME, 'failed', 10 + i)),
  ];
  writeLog(AGENT, entries);
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Dynamic import AFTER env var is set
type RouteModule = typeof import('../[agent]/executions/route');
let route: RouteModule;

beforeAll(async () => {
  route = await import('../[agent]/executions/route');
});

// ---------------------------------------------------------------------------
// Helper to call the GET handler
// ---------------------------------------------------------------------------

function makeRequest(agent: string, qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/workflows/crons/${encodeURIComponent(agent)}/executions?${qs}`);
}

async function callGet(agent: string, qs: string) {
  const req = makeRequest(agent, qs);
  return route.GET(req, { params: Promise.resolve({ agent }) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/workflows/crons/[agent]/executions — pagination shape', () => {
  it('returns {entries, total, hasMore} JSON by default', async () => {
    const res = await callGet(AGENT, 'limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; total: number; hasMore: boolean };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
    expect(body.total).toBe(15); // 10 fired + 5 failed
    expect(body.entries).toHaveLength(5);
    expect(body.hasMore).toBe(true);
  });

  it('offset=10 returns remaining 5, hasMore=false', async () => {
    const res = await callGet(AGENT, 'limit=10&offset=10');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; total: number; hasMore: boolean };
    expect(body.entries).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });
});

describe('GET /api/workflows/crons/[agent]/executions — status filter', () => {
  it('?status=success returns only fired entries', async () => {
    const res = await callGet(AGENT, 'limit=100&status=success');
    const body = await res.json() as { entries: CronExecutionLogEntry[]; total: number };
    expect(body.total).toBe(10);
    expect(body.entries.every(e => e.status === 'fired')).toBe(true);
  });

  it('?status=failure returns only failed entries', async () => {
    const res = await callGet(AGENT, 'limit=100&status=failure');
    const body = await res.json() as { entries: CronExecutionLogEntry[]; total: number };
    expect(body.total).toBe(5);
    expect(body.entries.every(e => e.status === 'failed')).toBe(true);
  });

  it('?status=all (default) returns all entries', async () => {
    const res = await callGet(AGENT, 'limit=100&status=all');
    const body = await res.json() as { total: number };
    expect(body.total).toBe(15);
  });
});

describe('GET /api/workflows/crons/[agent]/executions — CSV export', () => {
  it('?format=csv sets Content-Disposition attachment header', async () => {
    const res = await callGet(AGENT, 'format=csv');
    expect(res.status).toBe(200);
    const contentDisposition = res.headers.get('Content-Disposition');
    expect(contentDisposition).not.toBeNull();
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('.csv');
  });

  it('CSV body has correct header row', async () => {
    const res = await callGet(AGENT, 'format=csv');
    const body = await res.text();
    const firstLine = body.split('\n')[0];
    expect(firstLine).toBe('timestamp,cron,status,attempt,duration_ms,error');
  });

  it('CSV body contains data rows', async () => {
    const res = await callGet(AGENT, 'format=csv&limit=0');
    const body = await res.text();
    const lines = body.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThan(1); // header + data
    expect(lines.length).toBe(16); // 1 header + 15 entries
  });

  it('?format=csv with ?status=success filters before export', async () => {
    const res = await callGet(AGENT, 'format=csv&limit=0&status=success');
    const body = await res.text();
    const lines = body.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(11); // 1 header + 10 fired
  });
});

describe('GET /api/workflows/crons/[agent]/executions — JSON download export', () => {
  it('?format=json-download sets Content-Disposition header', async () => {
    const res = await callGet(AGENT, 'format=json-download');
    expect(res.status).toBe(200);
    const contentDisposition = res.headers.get('Content-Disposition');
    expect(contentDisposition).not.toBeNull();
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('.json');
  });

  it('JSON download body is valid JSON array', async () => {
    const res = await callGet(AGENT, 'format=json-download&limit=0');
    const body = await res.text();
    const parsed = JSON.parse(body) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(15);
  });

  it('Content-Type is application/json for JSON download', async () => {
    const res = await callGet(AGENT, 'format=json-download');
    const ct = res.headers.get('Content-Type') ?? '';
    expect(ct).toContain('application/json');
  });
});

describe('GET /api/workflows/crons/[agent]/executions — validation', () => {
  it('400 for invalid agent name (spaces)', async () => {
    const res = await callGet('invalid agent', '');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid agent name');
  });

  it('empty log → {entries:[], total:0, hasMore:false}', async () => {
    const res = await callGet('no-such-agent', 'limit=10');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; total: number; hasMore: boolean };
    expect(body.entries).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});
