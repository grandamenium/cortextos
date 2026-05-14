import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// redirect throws internally in Next.js — mock before importing the action
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }) }));

import { createStripePortalSession } from '../stripe';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.STRIPE_API_KEY;
});

afterEach(() => {
  delete process.env.STRIPE_API_KEY;
});

describe('createStripePortalSession — no STRIPE_API_KEY', () => {
  it('returns ok:false without calling fetch', async () => {
    const result = await createStripePortalSession({
      customer_id: 'cus_test',
      return_url: 'https://example.com/billing',
    });
    expect(result).toEqual({ ok: false, reason: 'Stripe is not configured on this server.' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('createStripePortalSession — with STRIPE_API_KEY', () => {
  beforeEach(() => {
    process.env.STRIPE_API_KEY = 'sk_test_abc123';
  });

  it('POSTs to Stripe and redirects to the session URL on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://billing.stripe.com/session/sess_123' }),
    });

    let thrown: Error | null = null;
    try {
      await createStripePortalSession({ customer_id: 'cus_abc', return_url: 'https://dash.example.com/portal/abc' });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown?.message).toMatch(/REDIRECT:https:\/\/billing\.stripe\.com\/session\/sess_123/);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/billing_portal/sessions',
      expect.objectContaining({ method: 'POST' }),
    );

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const authHeader = (call[1].headers as Record<string, string>)['Authorization'];
    expect(authHeader).toMatch(/^Basic /);
    // Basic auth: base64(key:) — key should be present
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('sk_test_abc123:');
  });

  it('returns ok:false on Stripe API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'No such customer' } }),
    });

    const result = await createStripePortalSession({
      customer_id: 'cus_bad',
      return_url: 'https://example.com',
    });
    expect((result as { ok: false; reason: string }).ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('No such customer');
  });

  it('sends customer and return_url in the POST body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://billing.stripe.com/session/x' }),
    });

    try {
      await createStripePortalSession({ customer_id: 'cus_xyz', return_url: 'https://portal.test/back' });
    } catch {
      // expected redirect throw
    }

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('customer=cus_xyz');
    expect(body).toContain('return_url=');
  });
});
