import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function LaneHeader({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">{label}</p>
      {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  negative,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  negative?: boolean;
}) {
  return (
    <Card className={cn(accent && 'border-amber-500/40', negative && 'border-red-500/40')}>
      <CardContent className="space-y-1 py-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-semibold tabular-nums', negative && 'text-red-500', accent && 'text-amber-500')}>
          {value}
        </p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
