import { cn } from '@/lib/utils';
import type { DealStatus } from '@/lib/types';

const STATUS_CONFIG: Record<DealStatus, { label: string; className: string }> = {
  screening:    { label: 'Screening',    className: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
  underwriting: { label: 'Underwriting', className: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
  approved:     { label: 'Approved',     className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  funded:       { label: 'Funded',       className: 'bg-green-500/10 text-green-600 border-green-500/20' },
  closed:       { label: 'Closed',       className: 'bg-green-700/10 text-green-700 border-green-700/20' },
  passed:       { label: 'Passed',       className: 'bg-red-500/10 text-red-500 border-red-500/20' },
  monitoring:   { label: 'Monitoring',   className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
};

export function DealStatusBadge({ status }: { status: DealStatus }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: 'bg-muted text-muted-foreground border-border' };
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', cfg.className)}>
      {cfg.label}
    </span>
  );
}
