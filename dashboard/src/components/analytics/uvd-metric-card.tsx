'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import { CHART_GOLD } from '@/components/charts/chart-theme';
import type { UvdMetrics } from '@/lib/data/reports';

interface UvdMetricCardProps {
  data: UvdMetrics;
}

export function UvdMetricCard({ data }: UvdMetricCardProps) {
  const { latest, history } = data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          UVD / Week
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Unique Value Deliveries — agent-completed tasks with measurable output (14-day trend)
        </p>
      </CardHeader>
      <CardContent>
        {!latest ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No UVD data available. Run <code className="text-xs">cortextos bus compute-uvd</code> to generate metrics.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-3xl font-bold tabular-nums" style={{ color: CHART_GOLD }}>
                  {latest.uvd_count}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">UVD / {latest.window_days}d</p>
              </div>
              <div>
                <p className="text-3xl font-bold tabular-nums" style={{ color: CHART_GOLD }}>
                  {latest.uvd_per_day.toFixed(1)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">UVD / day</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-foreground">
                  {latest.tasks_evaluated}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">tasks evaluated</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-muted-foreground">
                  {latest.excluded_housekeeping + latest.excluded_no_result + latest.excluded_human_created}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">excluded</p>
              </div>
            </div>

            {/* Exclusion breakdown */}
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {latest.excluded_housekeeping > 0 && (
                <span>housekeeping: {latest.excluded_housekeeping}</span>
              )}
              {latest.excluded_no_result > 0 && (
                <span>no-result: {latest.excluded_no_result}</span>
              )}
              {latest.excluded_human_created > 0 && (
                <span>human-created: {latest.excluded_human_created}</span>
              )}
              {latest.excluded_outside_window > 0 && (
                <span>outside window: {latest.excluded_outside_window}</span>
              )}
            </div>

            {/* Trend chart */}
            {history.length > 1 ? (
              <AreaChart
                data={history}
                xKey="date"
                yKeys={['uvd_per_day']}
                colors={[CHART_GOLD]}
                height={180}
              />
            ) : (
              <p className="text-xs text-muted-foreground text-center py-4">
                Trend available after multiple days of data.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
