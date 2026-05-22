'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CodexHealthData } from '@/lib/data/codex-health';

interface CodexHealthPaneProps {
  data: CodexHealthData | null;
}

function UtilBar({ label, usedPct, alert }: { label: string; usedPct: number; alert: boolean }) {
  const pct = Math.min(Math.max(usedPct, 0), 100);
  const color = alert
    ? 'bg-red-500'
    : pct >= 75
      ? 'bg-amber-500'
      : pct >= 50
        ? 'bg-yellow-400'
        : 'bg-green-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-semibold tabular-nums ${alert ? 'text-red-500' : 'text-foreground'}`}>
          {pct}% used{alert ? ' ⚠' : ''}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function limitClassBadge(cls: string) {
  if (cls === 'long_lock') return <span className="text-xs font-medium text-red-500">long_lock</span>;
  if (cls === 'short_throttle') return <span className="text-xs font-medium text-amber-500">short_throttle</span>;
  if (cls === 'auth_expired') return <span className="text-xs font-medium text-purple-500">auth_expired</span>;
  return <span className="text-xs text-muted-foreground">{cls}</span>;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

export function CodexHealthPane({ data }: CodexHealthPaneProps) {
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Codex Account Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No data — codex_limit_hit events not yet observed.</p>
        </CardContent>
      </Card>
    );
  }

  const spendPct = Math.min(
    Math.round((data.spilloverSpendEstimateUsd / data.spilloverMonthlySoftCapUsd) * 100),
    100
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Codex Account Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* Account utilization */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {data.account?.account ?? 'gregharned@gmail.com'}
            </p>
            <span className="text-xs text-muted-foreground">
              src: {data.account?.source ?? 'unknown'}
            </span>
          </div>
          {data.account ? (
            <div className="space-y-2">
              <UtilBar
                label="5h rolling band"
                usedPct={data.account.five_hour_used_pct}
                alert={data.account.alert_5h}
              />
              <UtilBar
                label="Weekly cap"
                usedPct={data.account.seven_day_used_pct}
                alert={data.account.alert_7d}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Usage data unavailable — run checkUsageApi or wait for next heartbeat cycle.</p>
          )}
        </div>

        {/* Spillover spend */}
        <div className="space-y-2 pt-1 border-t">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Spillover spend (30d)</span>
            <span className="tabular-nums text-muted-foreground">
              ~${data.spilloverSpendEstimateUsd.toFixed(2)} / ${data.spilloverMonthlySoftCapUsd} cap
              <span className="ml-2 font-semibold text-foreground">{spendPct}%</span>
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${spendPct >= 80 ? 'bg-red-500' : spendPct >= 50 ? 'bg-amber-500' : 'bg-green-500'}`}
              style={{ width: `${spendPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.failoverCount30d} dispatch{data.failoverCount30d !== 1 ? 'es' : ''} × ~$0.40 estimate
            {data.autoFallbackAgents.length > 0 && (
              <> · auto-fallback ON: {data.autoFallbackAgents.join(', ')}</>
            )}
          </p>
        </div>

        {/* Recent failover dispatches */}
        {data.recentFailovers.length > 0 && (
          <div className="space-y-2 pt-1 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Failovers</p>
            <div className="space-y-1.5">
              {data.recentFailovers.slice(0, 5).map((ev) => (
                <div key={ev.id} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-muted-foreground truncate max-w-[140px]" title={ev.worker_name}>
                    {ev.worker_name ?? '—'}
                  </span>
                  <span className="text-muted-foreground">{ev.agent}</span>
                  <span className="text-muted-foreground tabular-nums">{relativeTime(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent limit hits */}
        {data.recentLimitHits.length > 0 && (
          <div className="space-y-2 pt-1 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Limit Events</p>
            <div className="space-y-1.5">
              {data.recentLimitHits.slice(0, 6).map((ev) => (
                <div key={ev.id} className="flex items-center justify-between text-xs gap-2">
                  <span className="text-muted-foreground">{ev.agent}</span>
                  {limitClassBadge(ev.limit_class)}
                  <span className="text-muted-foreground tabular-nums">{relativeTime(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.recentLimitHits.length === 0 && data.recentFailovers.length === 0 && (
          <p className="text-xs text-muted-foreground pt-1 border-t">No codex_limit_hit or codex_failover_dispatched events yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
