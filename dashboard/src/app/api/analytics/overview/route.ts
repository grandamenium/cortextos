import { NextRequest } from 'next/server';
import { getTaskThroughput, getAgentEffectiveness } from '@/lib/data/analytics';
import { getDailyCosts, getDailyCostByModel, getCurrentMonthCost, getCostByModel } from '@/lib/cost-parser';
import { getFleetHealth } from '@/lib/data/reports';
import { getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/overview?org=&days=30
 * Consolidated analytics data for the mobile app.
 * Returns fleet health, task throughput, agent effectiveness, and cost data.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get('org') ?? undefined;
  const days = parseInt(searchParams.get('days') ?? '30', 10);

  try {
    // Get all orgs if no specific org requested
    const agents = getAllAgents();
    const orgs = org ? [org] : [...new Set(agents.map(a => a.org))];

    // Fleet health — aggregate across orgs
    let fleetHealth = null;
    for (const o of orgs) {
      try {
        fleetHealth = getFleetHealth(o);
        if (fleetHealth) break;
      } catch {
        // ignore
      }
    }

    // Task throughput
    const throughput = await getTaskThroughput(days, org);

    // Agent effectiveness
    const effectiveness = await getAgentEffectiveness(org);

    // Cost data
    const dailyCosts = await getDailyCosts(days);
    const dailyCostByModel = await getDailyCostByModel(days);
    const currentMonthCost = await getCurrentMonthCost();
    const costByModel = await getCostByModel();

    return Response.json({
      fleetHealth,
      throughput,
      effectiveness,
      costs: {
        daily: dailyCosts,
        byModel: dailyCostByModel,
        currentMonth: currentMonthCost,
        modelBreakdown: costByModel,
      },
    });
  } catch (err) {
    console.error('[api/analytics/overview] error:', err);
    return Response.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
}
