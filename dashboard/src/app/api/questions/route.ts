/**
 * /api/questions — execute a single portal question for a client.
 *
 * GET ?client_id=<id>&question_id=<id>&period=7d
 *
 * Returns { available: true, data: ... } or { available: false, reason: '...' }.
 * Never returns 500 for data-gap cases; only for genuine BQ/config errors.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getClientSpend,
  getClientRevenue,
  getClientCpa,
  getCpaVsTarget,
  getClientLeads,
  getLeadGrowth,
  getBestCampaign,
  getBestCreative,
  getWastedSpend,
  getMonthPace,
  getActiveTests,
  getWeeklyWork,
  getTrackingHealth,
} from '@/lib/portal-questions';

export const dynamic = 'force-dynamic';

const E2E_TOKEN = process.env.E2E_TOKEN;

function isE2EAuthorized(req: NextRequest): boolean {
  if (!E2E_TOKEN) return false;
  return req.headers.get('x-e2e-token') === E2E_TOKEN;
}

function parsePeriod(period: string | null): { start: string; end: string } {
  const days = parseInt(period?.replace('d', '') ?? '7', 10);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id && !isE2EAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get('client_id');
  const questionId = searchParams.get('question_id');
  const period = searchParams.get('period') ?? '7d';

  if (!clientId || !questionId) {
    return NextResponse.json(
      { error: 'client_id and question_id are required' },
      { status: 400 },
    );
  }

  const range = parsePeriod(period);

  try {
    let data: unknown;
    switch (questionId) {
      case 'spend':         data = await getClientSpend(clientId, range);       break;
      case 'revenue':       data = await getClientRevenue(clientId, range);     break;
      case 'cpa':           data = await getClientCpa(clientId, range);         break;
      case 'cpa_vs_target': data = await getCpaVsTarget(clientId, range);       break;
      case 'leads':         data = await getClientLeads(clientId, range);       break;
      case 'lead_growth':   data = await getLeadGrowth(clientId, range);        break;
      case 'best_campaign': data = await getBestCampaign(clientId, range);      break;
      case 'best_creative': data = await getBestCreative(clientId, range);      break;
      case 'wasted_spend':  data = await getWastedSpend(clientId, range);       break;
      case 'month_pace':    data = await getMonthPace(clientId);                break;
      case 'active_tests':  data = await getActiveTests(clientId);              break;
      case 'weekly_work':   data = await getWeeklyWork(clientId);               break;
      case 'tracking_health': data = await getTrackingHealth(clientId);         break;
      default:
        return NextResponse.json(
          { error: `Unknown question_id: ${questionId}` },
          { status: 400 },
        );
    }
    return NextResponse.json({ available: true, question_id: questionId, client_id: clientId, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Not found') || message.includes('no data') || message.includes('Table')) {
      return NextResponse.json({
        available: false,
        question_id: questionId,
        client_id: clientId,
        reason: 'No data yet for this client',
      });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
