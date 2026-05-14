/**
 * /api/clients — list and create clients (Phase 11.1 E2E + admin use).
 *
 * GET  → list from analytics.clients (auth required)
 * POST → insert synthetic/onboarding client row (auth required or E2E token)
 */

import { NextRequest, NextResponse } from 'next/server';
import { BigQuery } from '@google-cloud/bigquery';
import { auth } from '@/lib/auth';
import { listClients } from '@/lib/bq-clients';
import { clientWelcome } from '@/lib/emails';

export const dynamic = 'force-dynamic';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'click-to-acquire';
const DATASET = 'analytics';
const E2E_TOKEN = process.env.E2E_TOKEN ?? 'e2e-smoke-test-001';

function getBQ() {
  return new BigQuery({ projectId: PROJECT });
}

function isE2EAuthorized(req: NextRequest): boolean {
  return req.headers.get('x-e2e-token') === E2E_TOKEN;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id && !isE2EAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const clients = await listClients();
    return NextResponse.json(clients);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch clients';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id && !isE2EAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const clientId = typeof body['client_id'] === 'string' ? body['client_id'] : null;
  const displayName = typeof body['display_name'] === 'string' ? body['display_name'] : null;
  const vertical = typeof body['vertical'] === 'string' ? body['vertical'] : 'general';

  if (!clientId || !displayName) {
    return NextResponse.json(
      { error: 'client_id and display_name are required' },
      { status: 400 },
    );
  }

  try {
    const bq = getBQ();
    await bq.dataset(DATASET).table('clients').insert([
      {
        client_id: clientId,
        display_name: displayName,
        vertical,
        status: 'onboarding',
        has_existing_accounts: false,
        cta_platform_managed: true,
        lifecycle_stage: 'onboarding',
        ingested_at: new Date().toISOString(),
      },
    ]);
    const contactEmail = typeof body['contact_email'] === 'string' ? body['contact_email'] : null;
    if (contactEmail) {
      clientWelcome({ to: contactEmail, clientName: displayName, clientId }).catch(() => {});
    }

    return NextResponse.json({ client_id: clientId, status: 'onboarding' }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'BQ insert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
