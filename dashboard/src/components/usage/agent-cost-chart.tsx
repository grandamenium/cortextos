'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import { CHART_GOLD } from '@/components/charts/chart-theme';

interface AgentCostChartProps {
  data: Array<{ date: string; cost: number }>;
}

export function AgentCostChart({ data }: AgentCostChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Daily cost
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <AreaChart
            data={data}
            xKey="date"
            yKeys={['cost']}
            colors={[CHART_GOLD]}
            height={200}
          />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
            No usage in this range
          </div>
        )}
      </CardContent>
    </Card>
  );
}
