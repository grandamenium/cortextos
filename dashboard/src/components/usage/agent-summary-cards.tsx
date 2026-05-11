'use client';

import { Card, CardContent } from '@/components/ui/card';

interface AgentSummaryCardsProps {
  cost_usd: number;
  input_cost_usd?: number;
  output_cost_usd?: number;
  cache_cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens: number;
  cron_runs: number;
  last_active: string | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function Stat({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
        {children}
      </CardContent>
    </Card>
  );
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function AgentSummaryCards({
  cost_usd,
  input_cost_usd,
  output_cost_usd,
  cache_cost_usd,
  input_tokens,
  output_tokens,
  total_tokens,
  cron_runs,
  last_active,
}: AgentSummaryCardsProps) {
  const hasBreakdown =
    typeof input_cost_usd === 'number' &&
    typeof output_cost_usd === 'number' &&
    typeof cache_cost_usd === 'number';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Cost" value={`$${cost_usd.toFixed(2)}`}>
        {hasBreakdown && (
          <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground tabular-nums">
            <div className="flex justify-between"><span>Input</span><span>{fmtUsd(input_cost_usd!)}</span></div>
            <div className="flex justify-between"><span>Output</span><span>{fmtUsd(output_cost_usd!)}</span></div>
            <div className="flex justify-between"><span>Cache</span><span>{fmtUsd(cache_cost_usd!)}</span></div>
          </div>
        )}
      </Stat>
      <Stat label="Tokens" value={formatTokens(total_tokens)}>
        {typeof input_tokens === 'number' && typeof output_tokens === 'number' && (
          <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground tabular-nums">
            <div className="flex justify-between"><span>Input</span><span>{formatTokens(input_tokens)}</span></div>
            <div className="flex justify-between"><span>Output</span><span>{formatTokens(output_tokens)}</span></div>
            <div className="flex justify-between"><span>Cache</span><span>{formatTokens(total_tokens - input_tokens - output_tokens)}</span></div>
          </div>
        )}
      </Stat>
      <Stat label="Cron runs" value={`${cron_runs}`} />
      <Stat
        label="Last active"
        value={formatRelative(last_active)}
        sub={last_active ? new Date(last_active).toLocaleString() : undefined}
      />
    </div>
  );
}
