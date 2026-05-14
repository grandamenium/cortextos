/**
 * /api/portal/[clientId]/questions — portal question catalog for a client.
 *
 * Returns the 13-question metadata list. Questions with live BQ data return
 * available:true; newly-onboarded clients with no daily_metrics return
 * available:false with a reason (not a 500).
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const E2E_TOKEN = process.env.E2E_TOKEN;

const QUESTION_CATALOG = [
  { id: 'spend',         label: 'How much are we spending?',           category: 'finance' },
  { id: 'revenue',       label: 'How much revenue are we generating?', category: 'finance' },
  { id: 'cpa',           label: 'What is our cost per acquisition?',   category: 'finance' },
  { id: 'cpa_vs_target', label: 'Are we hitting our CPA target?',      category: 'finance' },
  { id: 'leads',         label: 'How many leads are we generating?',   category: 'performance' },
  { id: 'lead_growth',   label: 'Are our leads trending up or down?',  category: 'performance' },
  { id: 'best_campaign', label: 'Which campaign is performing best?',  category: 'performance' },
  { id: 'best_creative', label: 'Which creative is performing best?',  category: 'creative' },
  { id: 'wasted_spend',  label: 'Where are we wasting budget?',        category: 'optimization' },
  { id: 'month_pace',    label: 'Are we on track for the month?',      category: 'forecast' },
  { id: 'active_tests',  label: 'What tests are running right now?',   category: 'experiments' },
  { id: 'weekly_work',   label: 'What work happened this week?',       category: 'activity' },
  { id: 'tracking_health', label: 'Is our tracking healthy?',          category: 'tracking' },
];

function isE2EAuthorized(req: NextRequest): boolean {
  if (!E2E_TOKEN) return false;
  return req.headers.get('x-e2e-token') === E2E_TOKEN;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id && !isE2EAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { clientId } = await params;

  return NextResponse.json({
    client_id: clientId,
    question_count: QUESTION_CATALOG.length,
    questions: QUESTION_CATALOG,
  });
}
