import {
  getCurrentKpis,
  getDailyTimeSeries,
  getAcquisitionLtv,
  getChurnFunnel,
  getCohortRetention,
  getCancellingMembers,
  getTierDistribution,
  getDataMaturity,
  getUpcomingOutreach,
  getWeekOverWeekDeltas,
  getSourceCohortRetention,
  type SkoolRange,
} from '@/lib/data/skool';
import { OutreachQueue } from '@/components/skool/outreach-queue';
import { SourceCohortHeatmap } from '@/components/skool/source-cohort-heatmap';
import { HeroKpis } from '@/components/skool/hero-kpis';
import { MrrTimeline } from '@/components/skool/mrr-timeline';
import { MemberCountsTimeline } from '@/components/skool/member-counts-timeline';
import { DailyChurnChart } from '@/components/skool/daily-churn-chart';
import { AcquisitionMix } from '@/components/skool/acquisition-mix';
import { TierDistribution } from '@/components/skool/tier-distribution';
import { CohortRetentionHeatmap } from '@/components/skool/cohort-retention-heatmap';
import { AtRiskMembersTable } from '@/components/skool/at-risk-members-table';
import { ChurnFunnelChart } from '@/components/skool/churn-funnel-chart';
import { RangeFilter } from '@/components/skool/range-filter';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeRange(input: unknown): SkoolRange {
  const v = Array.isArray(input) ? input[0] : input;
  if (v === '7d' || v === '30d' || v === '90d' || v === 'all') return v;
  return '30d';
}

export default async function SkoolAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const range = normalizeRange(params.range);

  const [kpis, series, ltv, funnel, cohort, cancelling, tiers, maturity, outreach, wow, sourceCohort] = await Promise.all([
    getCurrentKpis(),
    getDailyTimeSeries(range),
    getAcquisitionLtv(),
    getChurnFunnel(),
    getCohortRetention(12),
    getCancellingMembers(),
    getTierDistribution(),
    getDataMaturity(),
    getUpcomingOutreach(200),
    getWeekOverWeekDeltas(),
    getSourceCohortRetention(3),
  ]);

  return (
    <div className="space-y-6 p-6 max-w-[1400px] mx-auto" data-testid="skool-analytics-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skool Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Agent Architects community — member growth, churn, retention, and acquisition LTV.
          </p>
        </div>
        <RangeFilter />
      </div>

      <HeroKpis kpis={kpis} maturity={maturity} wow={wow} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MrrTimeline series={series} />
        <MemberCountsTimeline series={series} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DailyChurnChart series={series} />
        <TierDistribution rows={tiers} />
      </div>

      <AcquisitionMix rows={ltv} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CohortRetentionHeatmap rows={cohort} />
        <ChurnFunnelChart rows={funnel} />
      </div>

      <SourceCohortHeatmap rows={sourceCohort} />

      <AtRiskMembersTable members={cancelling} />

      <OutreachQueue rows={outreach} />
    </div>
  );
}
