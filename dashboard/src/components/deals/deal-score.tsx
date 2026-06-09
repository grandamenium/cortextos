import { cn } from '@/lib/utils';

function scoreColor(score: number) {
  if (score >= 70) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-500';
}

export function DealScore({ score }: { score?: number }) {
  if (score === undefined || score === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className={cn('text-sm font-semibold tabular-nums', scoreColor(score))}>
      {score}
    </span>
  );
}
