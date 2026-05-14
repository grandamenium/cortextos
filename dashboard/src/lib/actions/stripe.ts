'use server';

import { redirect } from 'next/navigation';

interface StripePortalSession {
  url: string;
}

/**
 * Creates a Stripe Customer Portal session and redirects the user to it.
 * Returns { ok: false, reason } if STRIPE_API_KEY is not configured (graceful 503).
 */
export async function createStripePortalSession({
  customer_id,
  return_url,
}: {
  customer_id: string;
  return_url: string;
}): Promise<{ ok: false; reason: string } | never> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'Stripe is not configured on this server.' };
  }

  const body = new URLSearchParams({ customer: customer_id, return_url });

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: { message: res.statusText } }))) as {
      error?: { message?: string };
    };
    return { ok: false, reason: err?.error?.message ?? 'Stripe API error' };
  }

  const session = (await res.json()) as StripePortalSession;
  redirect(session.url);
}
