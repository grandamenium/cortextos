import { NextRequest, NextResponse } from 'next/server';
import {
  getAgentUsageSummary,
  getAgentDailyCost,
  getAgentDailyCostByModel,
  type RangeDays,
} from '@/lib/usage-queries';
import { syncCostsLazy } from '@/lib/sync';

export const dynamic = 'force-dynamic';

function parseDays(value: string | null): RangeDays {
  if (value === 'all') return 'all';
  const n = Number(value);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 30;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get('days'));
  const refresh = url.searchParams.get('refresh') === '1';

  syncCostsLazy(refresh);

  const summary = getAgentUsageSummary(name, days);
  if (!summary) {
    return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  }
  const dailyCost = getAgentDailyCost(name, days);
  const dailyByModel = getAgentDailyCostByModel(name, days);

  return NextResponse.json({ summary, dailyCost, dailyByModel, range: days });
}
