'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { RangePicker, type Range } from '@/components/usage/range-picker';
import { AgentSummaryCards } from '@/components/usage/agent-summary-cards';
import { AgentCostChart } from '@/components/usage/agent-cost-chart';
import { AgentModelBreakdown } from '@/components/usage/agent-model-breakdown';
import { CronAttributionTable } from '@/components/usage/cron-attribution-table';
import { SessionList } from '@/components/usage/session-list';

interface AgentResponse {
  summary: {
    agent: string;
    org: string;
    runtime: 'claude-code' | 'codex-app-server' | 'hermes';
    cron_mode: 'inject' | 'print' | null;
    cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    cache_cost_usd: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    message_count: number;
    cron_runs: number;
    last_active: string | null;
  };
  dailyCost: Array<{ date: string; cost: number }>;
  dailyByModel: Array<Record<string, unknown>>;
}

interface CronsResponse {
  aggregates: Array<{
    cron: string;
    runs: number;
    total_tokens: number;
    cost_usd: number;
    last_fire: string;
    last_status: 'fired' | 'retried' | 'failed';
    approximate: boolean;
  }>;
  runs: Array<{
    ts: string;
    cron: string;
    status: 'fired' | 'retried' | 'failed';
    duration_ms: number;
    error?: string | null;
    total_tokens: number;
    cost_usd: number;
    approximate: boolean;
  }>;
}

interface SessionsResponse {
  sessions: Array<{
    source_file: string;
    session_label: string;
    started_at: string;
    ended_at: string;
    message_count: number;
    total_tokens: number;
    cost_usd: number;
    model: string;
  }>;
}

function runtimeBadge(runtime: AgentResponse['summary']['runtime']) {
  if (runtime === 'codex-app-server') return 'codex';
  if (runtime === 'hermes') return 'hermes';
  return 'claude';
}

export default function AgentUsagePage() {
  const params = useParams<{ agent: string }>();
  const agent = decodeURIComponent(params.agent);

  const router = useRouter();
  const searchParams = useSearchParams();
  const range = (searchParams.get('range') as Range | null) ?? '30';

  const [agentData, setAgentData] = useState<AgentResponse | null>(null);
  const [crons, setCrons] = useState<CronsResponse | null>(null);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (r: Range, force = false) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const q = `days=${r}${force ? '&refresh=1' : ''}`;
        const [a, c, s] = await Promise.all([
          fetch(`/api/usage/agents/${encodeURIComponent(agent)}?${q}`),
          fetch(`/api/usage/agents/${encodeURIComponent(agent)}/crons?${q}`),
          fetch(`/api/usage/agents/${encodeURIComponent(agent)}/sessions?${q}`),
        ]);
        if (a.status === 404) {
          setError('Agent not found');
          setAgentData(null);
          return;
        }
        if (!a.ok) throw new Error(`agent ${a.status}`);
        setAgentData(await a.json());
        setCrons(c.ok ? await c.json() : { aggregates: [], runs: [] });
        setSessions(s.ok ? await s.json() : { sessions: [] });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [agent],
  );

  useEffect(() => {
    load(range);
  }, [range, load]);

  useEffect(() => {
    function onFocus() {
      load(range);
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [range, load]);

  function setRange(next: Range) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('range', next);
    router.replace(`/usage/${encodeURIComponent(agent)}?${params.toString()}`, { scroll: false });
  }

  const summary = agentData?.summary;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/usage"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <IconArrowLeft size={12} /> Usage
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{agent}</h1>
            {summary && (
              <>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {runtimeBadge(summary.runtime)}
                </Badge>
                {summary.cron_mode && (
                  <Badge variant="ghost" className="font-mono text-[10px]">
                    cron:{summary.cron_mode}
                  </Badge>
                )}
                {summary.org && (
                  <span className="text-xs text-muted-foreground">{summary.org}</span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => load(range, true)}
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
          <RangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {summary && (
        <>
          <AgentSummaryCards
            cost_usd={summary.cost_usd}
            input_cost_usd={summary.input_cost_usd}
            output_cost_usd={summary.output_cost_usd}
            cache_cost_usd={summary.cache_cost_usd}
            input_tokens={summary.input_tokens}
            output_tokens={summary.output_tokens}
            total_tokens={summary.total_tokens}
            cron_runs={summary.cron_runs}
            last_active={summary.last_active}
          />

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="crons">Crons ({crons?.aggregates.length ?? 0})</TabsTrigger>
              <TabsTrigger value="sessions">Sessions ({sessions?.sessions.length ?? 0})</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4 space-y-4">
              <AgentCostChart data={agentData?.dailyCost ?? []} />
              <AgentModelBreakdown data={agentData?.dailyByModel ?? []} />
            </TabsContent>

            <TabsContent value="crons" className="mt-4 space-y-4">
              <CronAttributionTable
                aggregates={crons?.aggregates ?? []}
                runs={crons?.runs ?? []}
              />
            </TabsContent>

            <TabsContent value="sessions" className="mt-4 space-y-4">
              <SessionList sessions={sessions?.sessions ?? []} />
            </TabsContent>
          </Tabs>
        </>
      )}

      {loading && !summary && !error && (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  );
}
