'use client';

import {
  LineChart,
  Line,
} from 'recharts';
import { CHART_GOLD } from './chart-theme';

export interface SparkLineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Tiny inline sparkline for embedding in cards / table cells.
 */
export function SparkLine({
  data,
  color = CHART_GOLD,
  width = 80,
  height = 24,
  className,
}: SparkLineProps) {
  const chartData = data.map((value, i) => ({ i, v: value }));

  return (
    <div className={className} style={{ display: 'inline-block', width, height, minWidth: 1, minHeight: 1 }}>
      <LineChart data={chartData} width={width} height={height}>
        <Line
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}
