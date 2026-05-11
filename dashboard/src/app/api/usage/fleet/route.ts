import { NextRequest, NextResponse } from 'next/server';
import {
  getFleetUsageSummary,
  getFleetDailyCostByModel,
  getFleetAgentList,
  getAgentSparkline,
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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get('days'));
  const refresh = url.searchParams.get('refresh') === '1';

  syncCostsLazy(refresh);

  const totals = getFleetUsageSummary(days);
  const dailyByModel = getFleetDailyCostByModel(days);
  const agents = getFleetAgentList(days).map((a) => ({
    ...a,
    sparkline: getAgentSparkline(a.agent, 14),
  }));

  return NextResponse.json({ totals, dailyByModel, agents, range: days });
}
