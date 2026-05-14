import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-001' } })),
}));

import { GET } from '../[clientId]/questions/route';

async function callGET(clientId: string): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/portal/${clientId}/questions`);
  return GET(req, { params: Promise.resolve({ clientId }) });
}

describe('GET /api/portal/[clientId]/questions', () => {
  it('returns 13 questions for any client', async () => {
    const res = await callGET('acme');
    expect(res.status).toBe(200);
    const body = await res.json() as { question_count: number; questions: Array<{ id: string; label: string; category: string }>; client_id: string };
    expect(body.question_count).toBe(13);
    expect(body.questions).toHaveLength(13);
    expect(body.client_id).toBe('acme');
  });

  it('each question has id, label, and category', async () => {
    const res = await callGET('beta');
    const body = await res.json() as { questions: Array<{ id: string; label: string; category: string }> };
    for (const q of body.questions) {
      expect(typeof q.id).toBe('string');
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.label).toBe('string');
      expect(typeof q.category).toBe('string');
    }
  });

  it('includes all expected question IDs', async () => {
    const res = await callGET('acme');
    const body = await res.json() as { questions: Array<{ id: string }> };
    const ids = body.questions.map((q) => q.id);
    const expected = [
      'spend', 'revenue', 'cpa', 'cpa_vs_target', 'leads', 'lead_growth',
      'best_campaign', 'best_creative', 'wasted_spend', 'month_pace',
      'active_tests', 'weekly_work', 'tracking_health',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('returns 401 without auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await callGET('acme');
    expect(res.status).toBe(401);
  });

  it('E2E token bypasses auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const req = new NextRequest('http://localhost:3000/api/portal/e2e-client/questions', {
      headers: { 'x-e2e-token': 'e2e-smoke-test-001' },
    });
    const res = await GET(req, { params: Promise.resolve({ clientId: 'e2e-client' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { question_count: number };
    expect(body.question_count).toBe(13);
  });
});
