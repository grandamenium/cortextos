import { createStripePortalSession } from '@/lib/actions/stripe';
import { headers } from 'next/headers';

interface Props {
  params: Promise<{ clientId: string }>;
}

export default async function BillingPage({ params }: Props) {
  const { clientId } = await params;

  const stripeConfigured = !!process.env.STRIPE_API_KEY;
  const stripeCustomerId = process.env[`STRIPE_CUSTOMER_${clientId.toUpperCase()}`] ?? null;

  if (!stripeConfigured) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
        <h1 className="mb-2 text-lg font-semibold text-amber-800">Billing unavailable</h1>
        <p className="text-sm text-amber-700">
          Stripe is not configured on this server. Contact your account manager.
        </p>
      </div>
    );
  }

  if (!stripeCustomerId) {
    return (
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-gray-900">Billing</h1>
        <p className="text-sm text-gray-500">
          Your billing portal is not yet set up. Contact your account manager to get access.
        </p>
      </div>
    );
  }

  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'dashboard.clicktoacquire.com';
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const returnUrl = `${proto}://${host}/portal/${clientId}`;

  async function openPortal() {
    'use server';
    const result = await createStripePortalSession({
      customer_id: stripeCustomerId!,
      return_url: returnUrl,
    });
    if (result && !result.ok) {
      throw new Error(result.reason);
    }
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-semibold text-gray-900">Billing</h1>
      <p className="mb-6 text-sm text-gray-500">
        Manage your payment method, invoices, and subscription.
      </p>
      <form action={openPortal}>
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          Open Billing Portal
        </button>
      </form>
    </div>
  );
}
