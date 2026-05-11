'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart } from '@/components/charts/bar-chart';
import { MODEL_COLORS, CHART_COLORS } from '@/components/charts/chart-theme';
import { FleetTable } from '@/components/usage/fleet-table';
import { RangePicker, type Range } from '@/components/usage/range-picker';
import { IconRefresh } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface FleetResponse {
  totals: {
    total_cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    cache_cost_usd: number;
    total_tokens: number;
    agent_count: number;
    cron_runs: number;
  };
  dailyByModel: Array<Record<string, unknown>>;
  agents: Array<{
    agent: string;
    org: string;
    runtime: 'claude-code' | 'codex-app-server' | 'hermes';
    cron_mode: 'inject' | 'print' | null;
    cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    cache_cost_usd: number;
    total_tokens: number;
    cron_runs: number;
    last_active: string | null;
    sparkline: number[];
  }>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export default function UsagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rangeParam = (searchParams.get('range') as Range | null) ?? '30';

  const [data, setData] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (range: Range, force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const url = `/api/usage/fleet?days=${range}${force ? '&refresh=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fleet ${res.status}`);
      const json = (await res.json()) as FleetResponse;
      setData(json);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(rangeParam);
  }, [rangeParam, load]);

  // Re-fetch on window focus so usage feels live after a chat message
  useEffect(() => {
    function onFocus() {
      load(rangeParam);
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [rangeParam, load]);

  function setRange(next: Range) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('range', next);
    router.replace(`/usage?${params.toString()}`, { scroll: false });
  }

  const totals = data?.totals;
  const dailyByModel = data?.dailyByModel ?? [];
  const modelKeys = (() => {
    const keys = new Set<string>();
    for (const row of dailyByModel) {
      for (const k of Object.keys(row)) {
        if (k !== 'date') keys.add(k);
      }
    }
    return Array.from(keys);
  })();
  const modelColors = modelKeys.map(
    (k) => MODEL_COLORS[k] ?? CHART_COLORS[modelKeys.indexOf(k) % CHART_COLORS.length],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Token consumption and cost attribution across all agents, including cron workflow runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => load(rangeParam, true)}
            disabled={refreshing}
            aria-label="Refresh now"
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border bg-background/50 px-2.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              refreshing
                ? 'text-muted-foreground/60'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <IconRefresh size={12} className={cn(refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <RangePicker value={rangeParam} onChange={setRange} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Total cost
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${totals ? totals.total_cost_usd.toFixed(2) : '—'}
            </p>
            {totals && (
              <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground tabular-nums">
                <div className="flex justify-between"><span>Input</span><span>${totals.input_cost_usd.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>Output</span><span>${totals.output_cost_usd.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>Cache</span><span>${totals.cache_cost_usd.toFixed(2)}</span></div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Tokens
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {totals ? formatTokens(totals.total_tokens) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Agents
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {totals ? totals.agent_count : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Cron runs
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {totals ? totals.cron_runs : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Daily cost by model
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dailyByModel.length > 0 && modelKeys.length > 0 ? (
            <BarChart
              data={dailyByModel}
              xKey="date"
              yKeys={modelKeys}
              colors={modelColors}
              stacked
              showLegend
              height={200}
            />
          ) : (
            <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
              {loading ? 'Loading…' : 'No data in this range'}
            </div>
          )}
        </CardContent>
      </Card>

      <FleetTable rows={data?.agents ?? []} />
    </div>
  );
}
