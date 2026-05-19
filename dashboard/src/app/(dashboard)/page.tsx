import { format } from 'date-fns';
import { getPendingApprovals, getPendingCount } from '@/lib/data/approvals';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getRecentEvents } from '@/lib/data/events';
import { ClaudeCodeLauncher } from '@/components/home/claude-code-launcher';
import { DecisionsQueue, type DecisionQueueRow } from '@/components/home/decisions-queue';
import { FleetPulse } from '@/components/home/fleet-pulse';
import { HeroStrip } from '@/components/home/hero-strip';
import { MissionFeed } from '@/components/home/mission-feed';
import { TodayMetrics, type TodayMetricCard } from '@/components/home/today-metrics';
import { TokenLimits } from '@/components/home/token-limits';
import { getAgentsList, getFleetPulse, getHomeOrg, getMissionFeed, getTopMission } from '@/lib/agents';
import { getRecentDispatches, getRecentPRs } from '@/lib/dispatch';
import { getLauncherSkills } from '@/lib/skills';
import { getTokenUsage } from '@/lib/token-usage';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

function formatHeroTime(): string {
  return format(new Date(), 'EEE h:mm a');
}

function getFleetMood(activeCount: number, totalCount: number): string {
  if (totalCount === 0) return 'Fleet quiet';
  if (activeCount >= Math.max(1, Math.ceil(totalCount * 0.6))) return 'Fleet cooking';
  if (activeCount >= Math.max(1, Math.ceil(totalCount * 0.3))) return 'Fleet steady';
  return 'Fleet quiet';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function buildDailySeries(tasks: Task[], kind: 'completed' | 'created' | 'blocked'): number[] {
  const now = new Date();
  const buckets = Array.from({ length: 8 }, () => 0);

  for (let dayOffset = 7; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - dayOffset,
      0,
      0,
      0,
      0,
    ));
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1_000;
    const bucketIndex = 7 - dayOffset;

    buckets[bucketIndex] = tasks.filter((task) => {
      const timestamp = kind === 'completed' ? task.completed_at : task.created_at;
      if (!timestamp) return false;
      const parsed = Date.parse(timestamp);
      if (!Number.isFinite(parsed) || parsed < dayStart || parsed >= dayEnd) return false;
      if (kind === 'blocked') return task.status === 'blocked';
      return true;
    }).length;
  }

  return buckets;
}

function percentDelta(current: number, baselineValues: number[]): string {
  const base = median(baselineValues);
  if (base === 0) return current === 0 ? '+0%' : '+100%';
  const raw = ((current - base) / base) * 100;
  const rounded = Math.round(raw);
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const org = getHomeOrg(params.org);

  const [
    fleet,
    topMission,
    missionFeed,
    launcherAgents,
    launcherSkills,
    pendingApprovals,
    pendingApprovalCount,
    allTasks,
    completedToday,
    tokenUsage,
    recentDispatches,
    openPrs,
    recentEvents,
  ] = await Promise.all([
    Promise.resolve(getFleetPulse(org)),
    Promise.resolve(getTopMission(org)),
    Promise.resolve(getMissionFeed(org)),
    Promise.resolve(getAgentsList()),
    Promise.resolve(getLauncherSkills()),
    Promise.resolve(getPendingApprovals(org)),
    Promise.resolve(getPendingCount(org)),
    Promise.resolve(getTasks({ org })),
    Promise.resolve(getTasksCompletedToday(org)),
    getTokenUsage(),
    Promise.resolve(getRecentDispatches(org)),
    Promise.resolve(getRecentPRs()),
    Promise.resolve(getRecentEvents(30, org)),
  ]);

  const activeFleetCount = fleet.filter((agent) => agent.health === 'green').length;
  const blockedTasks = allTasks.filter((task) => task.status === 'blocked');

  const decisionRows: DecisionQueueRow[] = [
    ...pendingApprovals.slice(0, 3).map((approval) => ({
      id: approval.id,
      title: approval.title,
      detail: `Approval requested by ${approval.agent}`,
      ctaLabel: 'Review',
      href: '/tasks?triage=approvals',
    })),
    ...blockedTasks.slice(0, 3).map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.description ?? 'Blocked task needs a decision.',
      ctaLabel: 'Open tasks',
      href: '/tasks?status=blocked',
    })),
    ...openPrs.slice(0, 3).map((pull) => ({
      id: `pr-${pull.number}`,
      title: `PR #${pull.number} · ${pull.title}`,
      detail: pull.headRefName,
      ctaLabel: 'Open PR',
      href: pull.url,
    })),
  ];

  if (decisionRows.length === 0) {
    decisionRows.push({
      id: 'fallback-decision',
      title: 'Review the task board',
      detail: 'No hot approvals or PRs surfaced, but the queue is ready for triage.',
      ctaLabel: 'Open tasks',
      href: '/tasks',
    });
  }

  const nextLabel = pendingApprovalCount > 0
    ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'} waiting`
    : blockedTasks.length > 0
      ? `${blockedTasks.length} blocked task${blockedTasks.length === 1 ? '' : 's'} want attention`
      : openPrs.length > 0
        ? `${openPrs.length} open PR${openPrs.length === 1 ? '' : 's'} awaiting review`
        : 'No urgent queue right now';

  const completedSeries = buildDailySeries(allTasks, 'completed');
  const blockedSeries = buildDailySeries(allTasks, 'blocked');
  const createdSeries = buildDailySeries(allTasks, 'created');

  const latestEventTime = recentEvents[0]?.timestamp;
  const todayCards: TodayMetricCard[] = [
    {
      id: 'velocity',
      title: 'Velocity',
      value: `${completedToday.length} tasks`,
      detail: `${allTasks.filter((task) => task.status === 'in_progress').length} active in the lane`,
      delta: percentDelta(completedToday.length, completedSeries.slice(0, -1)),
      sparkline: completedSeries,
    },
    {
      id: 'quality',
      title: 'Quality',
      value: `${blockedTasks.length} blockers`,
      detail: `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'} still open`,
      delta: percentDelta(blockedTasks.length, blockedSeries.slice(0, -1)),
      sparkline: blockedSeries,
    },
    {
      id: 'posture',
      title: 'Posture',
      value: `${openPrs.length} PRs`,
      detail: latestEventTime ? `Latest fleet event ${format(new Date(latestEventTime), 'h:mm a')}` : 'Watching the merge queue',
      delta: percentDelta(openPrs.length, createdSeries.slice(0, -1)),
      sparkline: createdSeries,
    },
  ];

  return (
    <div className="space-y-6 pb-8">
      <HeroStrip
        nowLabel={formatHeroTime()}
        mood={getFleetMood(activeFleetCount, fleet.length)}
        oneThing={topMission?.mission ?? 'No active mission — all quiet for the moment.'}
        nextLabel={nextLabel}
        nextHref={decisionRows[0]?.href ?? '/tasks'}
      />

      <FleetPulse agents={fleet} />

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <ClaudeCodeLauncher
          agents={launcherAgents}
          skills={launcherSkills.visible}
          overflow={launcherSkills.overflow}
          recentDispatches={recentDispatches}
        />
        <TokenLimits usage={tokenUsage} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <MissionFeed rows={missionFeed} />
        <DecisionsQueue rows={decisionRows} />
      </div>

      <TodayMetrics cards={todayCards} />
    </div>
  );
}
