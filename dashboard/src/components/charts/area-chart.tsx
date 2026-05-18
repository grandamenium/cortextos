'use client';

import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  AXIS_STYLE,
  GRID_STYLE,
  TOOLTIP_STYLE,
  getChartColor,
} from './chart-theme';
import { cn } from '@/lib/utils';

export interface AreaChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  height?: number;
  colors?: string[];
  showGrid?: boolean;
  showLegend?: boolean;
  className?: string;
}

export function AreaChart({
  data,
  xKey,
  yKeys,
  height = 250,
  colors,
  showGrid = true,
  showLegend = false,
  className,
}: AreaChartProps) {
  return (
    <div
      className={cn('min-w-0 w-full overflow-hidden', className)}
      style={{ minHeight: height, height }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <RechartsAreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <defs>
            {yKeys.map((key, i) => {
              const color = colors?.[i] ?? getChartColor(i);
              return (
                <linearGradient key={key} id={`area-grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.12} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.01} />
                </linearGradient>
              );
            })}
          </defs>
          {showGrid && <CartesianGrid {...GRID_STYLE} />}
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />}
          {yKeys.map((key, i) => {
            const color = colors?.[i] ?? getChartColor(i);
            return (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stroke={color}
                strokeWidth={2}
                fill="none"
                dot={false}
                activeDot={{ r: 4, fill: color, stroke: 'hsl(var(--background))' }}
              />
            );
          })}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
