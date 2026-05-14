import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clientWelcome, weeklyDigest, gateReadyForReview } from '../emails';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe('emails — no RESEND_API_KEY', () => {
  it('clientWelcome returns ok:false when key absent', async () => {
    const result = await clientWelcome({ to: 'a@b.com', clientName: 'Acme', clientId: 'acme' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Resend not configured');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('weeklyDigest returns ok:false when key absent', async () => {
    const result = await weeklyDigest({
      to: 'a@b.com',
      clientName: 'Acme',
      periodLabel: 'May 6–12',
      highlights: ['Leads up 12%'],
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('gateReadyForReview returns ok:false when key absent', async () => {
    const result = await gateReadyForReview({
      to: 'a@b.com',
      clientName: 'Acme',
      gateName: 'Budget increase',
      reviewUrl: 'https://example.com/review',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('emails — with RESEND_API_KEY', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key-123';
  });

  it('clientWelcome POSTs to Resend and returns ok:true on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'email-id-001' }),
    });

    const result = await clientWelcome({ to: 'client@acme.com', clientName: 'Acme', clientId: 'acme-001' });

    expect(result.ok).toBe(true);
    expect(result.id).toBe('email-id-001');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-123' }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, string>;
    expect(body.to).toBe('client@acme.com');
    expect(body.subject).toContain('Acme');
    expect(body.html).toContain('acme-001');
  });

  it('weeklyDigest includes all highlights in HTML', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'wk-001' }) });

    await weeklyDigest({
      to: 'client@acme.com',
      clientName: 'Acme',
      periodLabel: 'May 6–12',
      highlights: ['Leads up 12%', 'CPA down 8%'],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, string>;
    expect(body.html).toContain('Leads up 12%');
    expect(body.html).toContain('CPA down 8%');
    expect(body.html).toContain('May 6–12');
  });

  it('gateReadyForReview includes gate name and review URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'gr-001' }) });

    await gateReadyForReview({
      to: 'client@acme.com',
      clientName: 'Acme',
      gateName: 'Budget increase +20%',
      reviewUrl: 'https://dash.example.com/review/123',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, string>;
    expect(body.html).toContain('Budget increase +20%');
    expect(body.html).toContain('https://dash.example.com/review/123');
    expect(body.subject).toContain('Budget increase +20%');
  });

  it('returns ok:false on Resend API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Invalid API key' }),
    });

    const result = await clientWelcome({ to: 'a@b.com', clientName: 'X', clientId: 'x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Invalid API key');
  });
});
