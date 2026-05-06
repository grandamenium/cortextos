/**
 * dashboard/src/app/api/workflows/crons/__tests__/fire-route.test.ts
 * — Subtask 4.5
 *
 * API route tests for POST /api/workflows/crons/[agent]/[name]/fire:
 *   - 200 on successful fire (IPC returns success)
 *   - 403 when IPC returns manualFireDisabled error
 *   - 409 when IPC returns cooldown error
 *   - 404 when cron not found
 *   - 500 on IPC failure / agent not running
 *   - 400 on invalid agent or cron name (spaces in name)
 *   - 500 on IPC connection error
 *
 * Mocks IPCClient.send so no daemon process is needed.
 * Uses the @/ alias resolved by vitest.config.ts to dashboard/src.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock IPCClient before importing the route
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock('@/lib/ipc-client', () => {
  // Must be a proper constructor function (class-like)
  function IPCClient() {}
  IPCClient.prototype.send = mockSend;
  return { IPCClient };
});

// Import route AFTER mock registration
type FireRouteModule = typeof import('../[agent]/[name]/fire/route');
let route: FireRouteModule;

beforeEach(async () => {
  mockSend.mockReset();
  route = await import('../[agent]/[name]/fire/route');
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function callPost(agent: string, name: string) {
  const req = new NextRequest(
    `http://localhost/api/workflows/crons/${encodeURIComponent(agent)}/${encodeURIComponent(name)}/fire`,
    { method: 'POST' },
  );
  const params = Promise.resolve({ agent, name });
  return route.POST(req, { params });
}

// ---------------------------------------------------------------------------
// Success — 200
// ---------------------------------------------------------------------------

describe('POST fire route — success', () => {
  it('returns 200 with ok:true and firedAt on successful fire', async () => {
    const firedAt = 1_234_567_890_000;
    mockSend.mockResolvedValueOnce({
      success: true,
      data: { ok: true, firedAt },
    });

    const res = await callPost('boris', 'heartbeat');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.firedAt).toBe(firedAt);
  });

  it('sends correct IPC request shape', async () => {
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt: 1 } });

    await callPost('boris', 'heartbeat');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fire-cron',
        agent: 'boris',
        data: { name: 'heartbeat' },
        source: 'dashboard/api/fire',
      }),
    );
  });

  it('handles response when firedAt is absent from data', async () => {
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true } });

    const res = await callPost('boris', 'heartbeat');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // firedAt may be undefined — that's OK
  });
});

// ---------------------------------------------------------------------------
// manualFireDisabled — 403
// ---------------------------------------------------------------------------

describe('POST fire route — 403 manualFireDisabled', () => {
  it('returns 403 when IPC error contains "Manual fire disabled"', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Manual fire disabled for this cron.',
    });

    const res = await callPost('boris', 'secure-cron');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Manual fire disabled');
  });
});

// ---------------------------------------------------------------------------
// Cooldown — 409
// ---------------------------------------------------------------------------

describe('POST fire route — 409 cooldown', () => {
  it('returns 409 when IPC error contains "Cooldown active"', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: 'Cooldown active — wait 20s before firing again.',
    });

    const res = await callPost('boris', 'heartbeat');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Cooldown active');
  });
});

// ---------------------------------------------------------------------------
// Not found — 404
// ---------------------------------------------------------------------------

describe('POST fire route — 404 not found', () => {
  it('returns 404 when cron not found', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Cron 'ghost' not found for agent 'boris'.",
    });

    const res = await callPost('boris', 'ghost');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 404 when agent not found in cron lookup', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Cron 'heartbeat' not found for agent 'unknown'.",
    });

    const res = await callPost('unknown', 'heartbeat');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Agent not running — 500
// ---------------------------------------------------------------------------

describe('POST fire route — 500 runtime errors', () => {
  it('returns 500 when agent is not running', async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      error: "Agent 'boris' not found or not running.",
    });

    const res = await callPost('boris', 'heartbeat');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 500 on IPC connection error (exception)', async () => {
    mockSend.mockRejectedValueOnce(new Error('IPC request timed out'));

    const res = await callPost('boris', 'heartbeat');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('IPC error');
  });
});

// ---------------------------------------------------------------------------
// Input validation — 400
// ---------------------------------------------------------------------------

describe('POST fire route — 400 invalid input', () => {
  it('returns 400 for agent name with spaces', async () => {
    const req = new NextRequest(
      'http://localhost/api/workflows/crons/invalid%20agent/heartbeat/fire',
      { method: 'POST' },
    );
    const params = Promise.resolve({ agent: 'invalid agent', name: 'heartbeat' });
    const res = await route.POST(req, { params });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 for cron name with spaces', async () => {
    const req = new NextRequest(
      'http://localhost/api/workflows/crons/boris/bad%20name/fire',
      { method: 'POST' },
    );
    const params = Promise.resolve({ agent: 'boris', name: 'bad name' });
    const res = await route.POST(req, { params });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('accepts valid hyphenated names without error', async () => {
    mockSend.mockResolvedValueOnce({ success: true, data: { ok: true, firedAt: 1 } });
    const res = await callPost('my-agent', 'my-cron-name');
    expect(res.status).toBe(200);
  });
});
