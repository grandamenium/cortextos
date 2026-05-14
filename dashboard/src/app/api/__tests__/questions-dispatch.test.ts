import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-001' } })),
}));

// Stub all 13 portal-question functions — each returns a minimal result
vi.mock('@/lib/portal-questions', () => ({
  getClientSpend: vi.fn(async () => ({ total: 1000 })),
  getClientRevenue: vi.fn(async () => ({ total: 5000 })),
  getClientCpa: vi.fn(async () => ({ cpa: 50 })),
  getCpaVsTarget: vi.fn(async () => ({ cpa: 50, target: 60, on_target: true })),
  getClientLeads: vi.fn(async () => ({ total: 20 })),
  getLeadGrowth: vi.fn(async () => ({ growth_pct: 12 })),
  getBestCampaign: vi.fn(async () => ({ campaign_name: 'Test Campaign' })),
  getBestCreative: vi.fn(async () => ({ available: false })),
  getWastedSpend: vi.fn(async () => ({ wasted: 100 })),
  getMonthPace: vi.fn(async () => ({ on_pace: true })),
  getActiveTests: vi.fn(async () => ({ tests: [] })),
  getWeeklyWork: vi.fn(async () => ({ tasks: [] })),
  getTrackingHealth: vi.fn(async () => ({ healthy: true })),
}));

import { GET } from '../questions/route';

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/questions');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/questions', () => {
  it('returns 400 when client_id is missing', async () => {
    const res = await GET(makeRequest({ question_id: 'spend' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when question_id is missing', async () => {
    const res = await GET(makeRequest({ client_id: 'acme' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown question_id', async () => {
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'totally_unknown' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('totally_unknown');
  });

  it('returns 401 without auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'spend' }));
    expect(res.status).toBe(401);
  });

  it('dispatches spend question and returns available:true', async () => {
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'spend' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean; question_id: string; client_id: string; data: unknown };
    expect(body.available).toBe(true);
    expect(body.question_id).toBe('spend');
    expect(body.client_id).toBe('acme');
  });

  it.each([
    'spend', 'revenue', 'cpa', 'cpa_vs_target', 'leads', 'lead_growth',
    'best_campaign', 'best_creative', 'wasted_spend', 'month_pace',
    'active_tests', 'weekly_work', 'tracking_health',
  ])('dispatches question_id=%s without error', async (questionId) => {
    const res = await GET(makeRequest({ client_id: 'acme', question_id: questionId }));
    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean; question_id: string };
    expect(body.available).toBe(true);
    expect(body.question_id).toBe(questionId);
  });

  it('returns available:false on data-gap error (not 500)', async () => {
    const { getClientSpend } = await import('@/lib/portal-questions');
    vi.mocked(getClientSpend).mockRejectedValueOnce(new Error('Not found: no data'));
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'spend' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(typeof body.reason).toBe('string');
  });

  it('returns 500 on genuine BQ error', async () => {
    const { getClientRevenue } = await import('@/lib/portal-questions');
    vi.mocked(getClientRevenue).mockRejectedValueOnce(new Error('PERMISSION_DENIED: missing BigQuery permission'));
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'revenue' }));
    expect(res.status).toBe(500);
  });

  it('E2E token bypasses auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const req = new NextRequest('http://localhost:3000/api/questions?client_id=e2e&question_id=spend', {
      headers: { 'x-e2e-token': 'e2e-smoke-test-001' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('accepts period parameter and passes date range to functions', async () => {
    const { getClientSpend } = await import('@/lib/portal-questions');
    const res = await GET(makeRequest({ client_id: 'acme', question_id: 'spend', period: '30d' }));
    expect(res.status).toBe(200);
    // getClientSpend should have been called with a range object
    expect(vi.mocked(getClientSpend)).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ start: expect.any(String), end: expect.any(String) }),
    );
  });
});
