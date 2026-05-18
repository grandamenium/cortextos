'use client';

import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  getChartColor,
} from './chart-theme';
import { cn } from '@/lib/utils';

export interface BarChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  height?: number;
  colors?: string[];
  stacked?: boolean;
  showLegend?: boolean;
  className?: string;
}

export function BarChart({
  data,
  xKey,
  yKeys,
  height = 250,
  colors,
  stacked = false,
  showLegend = false,
  className,
}: BarChartProps) {
  return (
    <div
      className={cn('min-w-0 w-full overflow-hidden', className)}
      style={{ minHeight: height, height }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <RechartsBarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {yKeys.map((key, i) => {
            const color = colors?.[i] ?? getChartColor(i);
            return (
              <Bar
                key={key}
                dataKey={key}
                fill={color}
                radius={[3, 3, 0, 0]}
                stackId={stacked ? 'stack' : undefined}
                maxBarSize={40}
              />
            );
          })}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
