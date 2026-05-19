import { CHART_GOLD } from './chart-theme';

export interface SparkLineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

function buildSparkPath(data: number[], width: number, height: number): string {
  if (data.length === 0) return '';

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : width;

  return data
    .map((value, index) => {
      const x = index * stepX;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

/**
 * Tiny inline sparkline for embedding in cards / table cells.
 * Uses a fixed-size SVG to avoid client-only chart hydration and layout-shift noise.
 */
export function SparkLine({
  data,
  color = CHART_GOLD,
  width = 80,
  height = 24,
  className,
}: SparkLineProps) {
  const safeData = data.length > 0 ? data : [0, 0];
  const innerWidth = Math.max(width - 2, 1);
  const innerHeight = Math.max(height - 2, 1);
  const path = buildSparkPath(safeData, innerWidth, innerHeight);

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role="img"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(1 1)"
      />
    </svg>
  );
}
