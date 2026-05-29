'use client';

import { cn } from '@/lib/utils';
import { CHART_GOLD } from './chart-theme';

export interface ProgressBarProps {
  value: number; // 0-100
  className?: string;
  showLabel?: boolean;
  height?: 'sm' | 'md' | 'lg';
  color?: string;
  animated?: boolean;
}

export function ProgressBar({
  value,
  className,
  showLabel = false,
  height = 'md',
  color,
  animated = false,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  const heightClass = {
    sm: 'h-1.5',
    md: 'h-2.5',
    lg: 'h-4',
  }[height];

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-border',
          heightClass,
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            animated && 'animate-pulse',
          )}
          style={{
            width: `${clamped}%`,
            backgroundColor: color ?? CHART_GOLD,
          }}
        />
      </div>
      {showLabel && (
        <span className="text-sm tabular-nums text-muted-foreground min-w-[3ch] text-right">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}
