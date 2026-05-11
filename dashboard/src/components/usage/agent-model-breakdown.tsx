'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart } from '@/components/charts/bar-chart';
import { MODEL_COLORS, CHART_COLORS } from '@/components/charts/chart-theme';

interface AgentModelBreakdownProps {
  data: Array<Record<string, unknown>>;
}

export function AgentModelBreakdown({ data }: AgentModelBreakdownProps) {
  const keys = new Set<string>();
  for (const row of data) {
    for (const k of Object.keys(row)) {
      if (k !== 'date') keys.add(k);
    }
  }
  const modelKeys = Array.from(keys);
  // Map model keys to colors (gold-mustard for opus, fallbacks for others)
  const colors = modelKeys.map((k) => MODEL_COLORS[k] ?? CHART_COLORS[modelKeys.indexOf(k) % CHART_COLORS.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Cost by model
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 && modelKeys.length > 0 ? (
          <BarChart
            data={data}
            xKey="date"
            yKeys={modelKeys}
            colors={colors}
            stacked
            showLegend
            height={200}
          />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
            No model breakdown available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
