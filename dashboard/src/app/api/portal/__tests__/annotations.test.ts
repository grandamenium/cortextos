import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockInsert, mockQuery } = vi.hoisted(() => ({
  mockInsert: vi.fn(async () => {}),
  mockQuery: vi.fn(async () => [[]]),
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-001', email: 'test@example.com' } })),
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: function () {
    return {
      dataset: () => ({ table: () => ({ insert: mockInsert }) }),
      query: mockQuery,
    };
  },
}));

import { POST as annotationsPost, GET as annotationsGet } from '../annotations/route';

beforeEach(() => {
  mockInsert.mockReset();
  mockQuery.mockReset();
  mockInsert.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue([[]]);
});

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/portal/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/portal/annotations', () => {
  it('returns 400 when creative_id is missing', async () => {
    const res = await annotationsPost(makePostRequest({ client_id: 'acme', comment: 'hi' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('required');
  });

  it('returns 400 when comment is whitespace only', async () => {
    const res = await annotationsPost(makePostRequest({ creative_id: 'img-001', client_id: 'acme', comment: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/portal/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await annotationsPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 201 with annotation_id on valid input', async () => {
    const res = await annotationsPost(
      makePostRequest({ creative_id: 'img-001', client_id: 'acme', comment: 'Make the CTA bigger' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { annotation_id: string; creative_id: string; client_id: string; status: string };
    expect(body.annotation_id).toBeTruthy();
    expect(body.creative_id).toBe('img-001');
    expect(body.client_id).toBe('acme');
    expect(body.status).toBe('pending');
  });

  it('inserts correct fields into BQ', async () => {
    await annotationsPost(
      makePostRequest({
        creative_id: 'img-002',
        client_id: 'beta',
        comment: 'Change background',
        region_box: { x: 10, y: 20, width: 100, height: 50 },
      }),
    );

    expect(mockInsert).toHaveBeenCalled();
    const row = (mockInsert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0];
    expect(row.creative_id).toBe('img-002');
    expect(row.client_id).toBe('beta');
    expect(row.comment).toBe('Change background');
    expect(typeof row.region_box).toBe('string');
    expect(row.status).toBe('pending');
    expect(row.created_by).toBe('user-001');
    expect(typeof row.annotation_id).toBe('string');
  });

  it('returns 401 without auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await annotationsPost(
      makePostRequest({ creative_id: 'x', client_id: 'y', comment: 'z' }),
    );
    expect(res.status).toBe(401);
  });

  it('E2E token bypasses session auth', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const req = new NextRequest('http://localhost:3000/api/portal/annotations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-token': 'e2e-smoke-test-001',
      },
      body: JSON.stringify({ creative_id: 'img-e2e', client_id: 'e2e', comment: 'test annotation' }),
    });
    const res = await annotationsPost(req);
    expect(res.status).toBe(201);
  });
});

describe('GET /api/portal/annotations', () => {
  it('returns 400 when creative_id is missing', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/portal/annotations?client_id=acme',
    );
    const res = await annotationsGet(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when client_id is missing', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/portal/annotations?creative_id=img-001',
    );
    const res = await annotationsGet(req);
    expect(res.status).toBe(400);
  });

  it('returns annotation list on valid params', async () => {
    mockQuery.mockResolvedValueOnce([[
      {
        annotation_id: 'ann-001',
        creative_id: 'img-001',
        client_id: 'acme',
        comment: 'Nice work',
        status: 'pending',
        created_at: '2026-05-13T00:00:00Z',
        created_by: 'user-001',
        region_box: null,
      },
    ]]);
    const req = new NextRequest(
      'http://localhost:3000/api/portal/annotations?client_id=acme&creative_id=img-001',
    );
    const res = await annotationsGet(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { annotations: unknown[]; client_id: string; creative_id: string };
    expect(body.annotations).toHaveLength(1);
    expect(body.client_id).toBe('acme');
    expect(body.creative_id).toBe('img-001');
  });
});
