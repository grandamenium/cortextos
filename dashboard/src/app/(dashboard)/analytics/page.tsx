import { getOrgs } from '@/lib/config';
import { getGoals } from '@/lib/data/goals';
import { getTaskThroughput, getAgentEffectiveness } from '@/lib/data/analytics';
import {
  getDailyCosts,
  getDailyCostByModel,
  getCurrentMonthCost,
} from '@/lib/cost-parser';
import { syncCostsLazy } from '@/lib/sync';

import { TaskThroughput } from '@/components/analytics/task-throughput';
import { AgentEffectiveness } from '@/components/analytics/agent-effectiveness';
import { CostTracking } from '@/components/analytics/cost-tracking';
import { GoalProgress } from '@/components/analytics/goal-progress';
import { FleetHealth } from '@/components/analytics/fleet-health';
import { UvdMetricCard } from '@/components/analytics/uvd-metric-card';
import { getFleetHealth, getPlanUsage, getUsageHistory, getUvdMetrics } from '@/lib/data/reports';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';

  // Sync cost data lazily (only on this page, throttled)
  syncCostsLazy();

  // Fetch all data in parallel
  const [taskData, agentStats, dailyCosts, dailyCostByModel, monthCost, goalsData, fleetHealth, planUsage, usageHistory, uvdData] =
    await Promise.all([
      Promise.resolve(getTaskThroughput(30, org || undefined)),
      Promise.resolve(getAgentEffectiveness(org || undefined)),
      Promise.resolve(getDailyCosts(30)),
      Promise.resolve(getDailyCostByModel(30)),
      Promise.resolve(getCurrentMonthCost()),
      Promise.resolve(org ? getGoals(org) : { bottleneck: '', goals: [] }),
      Promise.resolve(getFleetHealth(org || 'default')),
      Promise.resolve(getPlanUsage()),
      Promise.resolve(getUsageHistory(7)),
      Promise.resolve(getUvdMetrics(org || 'revops-global', 14)),
    ]);

  // Project monthly cost: (month-to-date / days elapsed) * days in month
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projectedMonthly =
    dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {org ? `Org: ${org}` : 'All organizations'} - Performance metrics and cost tracking.
        </p>
      </div>

      {/* Fleet Health */}
      <FleetHealth data={fleetHealth} />

      {/* UVD Metric */}
      <UvdMetricCard data={uvdData} />

      {/* Task Throughput */}
      <TaskThroughput data={taskData} />

      {/* Agent Effectiveness */}
      <AgentEffectiveness agents={agentStats} />

      {/* Cost Tracking */}
      <CostTracking
        dailyCosts={dailyCosts}
        dailyCostByModel={dailyCostByModel}
        currentMonthCost={monthCost}
        projectedMonthly={projectedMonthly}
        planUsage={planUsage}
        usageHistory={usageHistory}
      />

      {/* Goal Progress - only show when specific org selected */}
      {org && <GoalProgress goals={goalsData.goals} />}

    </div>
  );
}
