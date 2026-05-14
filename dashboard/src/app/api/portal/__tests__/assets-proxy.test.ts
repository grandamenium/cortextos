import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-001' } })),
}));

// Mock crypto.createSign so RS256 JWT signing works with a fake key in tests
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    createSign: vi.fn(() => ({
      update: vi.fn(),
      sign: vi.fn(() => 'mock-signature-base64url'),
    })),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from '../[clientId]/assets/[fileId]/route';

const VALID_SA = JSON.stringify({
  client_email: 'sa@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHAGXHMnBFlqBOcWyD9b4G\n-----END RSA PRIVATE KEY-----',
  token_uri: 'https://oauth2.googleapis.com/token',
});

function makeRequest(clientId = 'acme', fileId = 'file-123'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/portal/${clientId}/assets/${fileId}`);
}

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
});

afterEach(() => {
  delete process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
});

async function callGET(clientId = 'acme', fileId = 'file-123') {
  const req = makeRequest(clientId, fileId);
  return GET(req, { params: Promise.resolve({ clientId, fileId }) });
}

describe('GET /api/portal/[clientId]/assets/[fileId]', () => {
  it('returns 503 when GDRIVE_SERVICE_ACCOUNT_JSON is absent', async () => {
    const res = await callGET();
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not configured');
  });

  it('returns 503 when GDRIVE_SERVICE_ACCOUNT_JSON is malformed JSON', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = 'not-valid-json{';
    const res = await callGET();
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('malformed');
  });

  it('returns 401 when unauthenticated and no E2E token', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = VALID_SA;
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it('returns 502 when GDrive OAuth token exchange fails', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = VALID_SA;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const res = await callGET();
    expect(res.status).toBe(502);
  });

  it('returns 404 when GDrive returns 404 for the file', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = VALID_SA;
    // OAuth token call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'tok-abc' }),
    });
    // File download returns 404
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const res = await callGET();
    expect(res.status).toBe(404);
  });

  it('streams file with correct Content-Type and cache headers on success', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = VALID_SA;
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok-abc' }) })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    const res = await callGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
  });

  it('E2E token bypasses session auth', async () => {
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = VALID_SA;
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok-e2e' }) })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => new ArrayBuffer(4),
      });
    const req = new NextRequest('http://localhost:3000/api/portal/acme/assets/file-e2e', {
      headers: { 'x-e2e-token': 'e2e-smoke-test-001' },
    });
    const res = await GET(req, { params: Promise.resolve({ clientId: 'acme', fileId: 'file-e2e' }) });
    expect(res.status).toBe(200);
  });
});
