import Link from 'next/link';
import { getOrgs } from '@/lib/config';
import { getPendingCount } from '@/lib/data/approvals';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getGoals } from '@/lib/data/goals';
import { getHealthSummary, getAllHeartbeats } from '@/lib/data/heartbeats';
import { getRecentEvents, getMilestones } from '@/lib/data/events';
import { discoverAgents } from '@/lib/data/agents';

import { ActionRequired } from '@/components/overview/action-required';
import { CurrentFocus } from '@/components/overview/current-focus';
import { TodaysProgress } from '@/components/overview/todays-progress';
import { LiveActivity } from '@/components/overview/live-activity';
import { SystemHealth } from '@/components/overview/system-health';
import { MetricCards } from '@/components/overview/metric-cards';
import { AgentStatusGrid } from '@/components/overview/agent-status-grid';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  // Default to empty string (all orgs) instead of first org, so all agents show
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';

  // Fetch all data in parallel
  const [
    pendingCount,
    blockedTasks,
    allTasks,
    goalsData,
    healthSummary,
    completedToday,
    recentEvents,
    milestones,
    agents,
    heartbeatsList,
  ] = await Promise.all([
    Promise.resolve(getPendingCount(org || undefined)),
    Promise.resolve(getTasks({ status: 'blocked', org: org || undefined })),
    Promise.resolve(getTasks({ org: org || undefined })),
    Promise.resolve(getGoals(org || 'default')),
    getHealthSummary(org || undefined),
    Promise.resolve(getTasksCompletedToday(org || undefined)),
    Promise.resolve(getRecentEvents(20, org || undefined)),
    Promise.resolve(getMilestones(org || undefined)),
    discoverAgents(org || undefined),
    getAllHeartbeats(),
  ]);

  // Convert heartbeats array to lookup map
  const heartbeats: Record<string, typeof heartbeatsList[number]> = {};
  for (const hb of heartbeatsList) {
    heartbeats[hb.agent] = hb;
  }

  const staleAgentCount = healthSummary.stale + healthSummary.down;
  const inProgressTasks = allTasks.filter(t => t.status === 'in_progress').length;
  const pendingTasks = allTasks.filter(t => t.status === 'pending').length;
  const humanTasks = allTasks.filter(t => t.assignee === 'human' && t.status !== 'completed').length;
  const totalActions = pendingCount + blockedTasks.length + staleAgentCount + humanTasks;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            {org ? `Organization: ${org}` : 'All organizations'}
          </p>
        </div>
        {totalActions > 0 && (
          <Link
            href="/approvals"
            className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
            {totalActions} action{totalActions !== 1 ? 's' : ''} needed
          </Link>
        )}
      </div>

      {/* Metric Cards */}
      <MetricCards
        agentsOnline={healthSummary.healthy}
        agentsTotal={healthSummary.healthy + healthSummary.stale + healthSummary.down}
        tasksCompleted={completedToday.length}
        tasksInProgress={inProgressTasks}
        tasksPending={pendingTasks}
        pendingApprovals={pendingCount}
        blockedTasks={blockedTasks.length}
      />

      {/* Action Required - only show if there are actions */}
      {totalActions > 0 && (
        <ActionRequired
          pendingApprovals={pendingCount}
          blockedTasks={blockedTasks.length}
          staleAgents={staleAgentCount}
          humanTasks={humanTasks}
        />
      )}

      {/* Agent Fleet Grid + Live Activity - two columns */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <AgentStatusGrid agents={agents} heartbeats={heartbeats} />
        </div>
        <div className="xl:col-span-1">
          <LiveActivity initialEvents={recentEvents} />
        </div>
      </div>

      {/* Current Focus + Today's Progress */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <CurrentFocus
            org={org || 'default'}
            bottleneck={goalsData.bottleneck}
            goals={goalsData.goals}
          />
        </div>
        <div className="lg:col-span-2">
          <TodaysProgress
            completedTasks={completedToday}
            milestones={milestones}
          />
        </div>
      </div>

      {/* System Health */}
      <SystemHealth summary={healthSummary} />
    </div>
  );
}
