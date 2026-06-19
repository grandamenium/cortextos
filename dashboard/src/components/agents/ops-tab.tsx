'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  IconAlertTriangle,
  IconPlayerPause,
  IconRefresh,
  IconHeartbeat,
  IconCpu,
  IconChartBar,
  IconCheck,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface OpsData {
  crashesToday: number;
  maxCrashesPerDay: number;
  halted: boolean;
  rateLimited: boolean;
  rateLimitResetsAt: string | null;
  rateLimitResetsAtMs: number | null;
  usage: {
    session: { used_pct: number; resets: string } | null;
    weekAllModels: { used_pct: number; resets: string } | null;
    weekSonnet: { used_pct: number } | null;
    timestamp: string | null;
  };
  uptime: {
    lastRestart: string | null;
    restartsTodayTotal: number;
    restartsType: { crash: number; watchdog: number; self: number; hard: number };
  };
  model: string | null;
}

function UsageBar({ label, pct, resets }: { label: string; pct: number; resets?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn(
          'font-mono font-medium',
          pct >= 90 ? 'text-red-500' :
          pct >= 70 ? 'text-amber-500' :
          'text-foreground',
        )}>
          {pct}%
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct >= 90 ? 'bg-red-500' :
            pct >= 70 ? 'bg-amber-500' :
            'bg-emerald-500',
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      {resets && (
        <p className="text-[10px] text-muted-foreground/60">
          Resets {resets}
        </p>
      )}
    </div>
  );
}

function Countdown({ targetMs }: { targetMs: number }) {
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    function update() {
      const diff = targetMs - Date.now();
      if (diff <= 0) {
        setRemaining('now');
        return;
      }
      const hours = Math.floor(diff / 3_600_000);
      const minutes = Math.floor((diff % 3_600_000) / 60_000);
      if (hours > 0) {
        setRemaining(`${hours}h ${minutes}m`);
      } else {
        setRemaining(`${minutes}m`);
      }
    }

    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [targetMs]);

  return <span className="font-mono">{remaining}</span>;
}

export function OpsTab({ agentName }: { agentName: string }) {
  const [data, setData] = useState<OpsData | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/ops`);
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [agentName]);

  if (loading && !data) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Loading operational data...</p>;
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No operational data available</p>;
  }

  return (
    <div className="space-y-4 mt-4">
      {/* Alert banners */}
      {data.halted && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
          <IconAlertTriangle size={20} className="text-red-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              Agent halted — {data.crashesToday} crashes today (limit: {data.maxCrashesPerDay})
            </p>
            <p className="text-xs text-red-500/70 mt-0.5">
              Agent will not auto-restart until tomorrow. Use the dashboard or CLI to manually start.
            </p>
          </div>
        </div>
      )}

      {data.rateLimited && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <IconPlayerPause size={20} className="text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Rate limited — paused until reset
            </p>
            <p className="text-xs text-amber-500/70 mt-0.5">
              {data.rateLimitResetsAt
                ? <>Resets at {data.rateLimitResetsAt}{data.rateLimitResetsAtMs && <> (<Countdown targetMs={data.rateLimitResetsAtMs} /> remaining)</>}</>
                : 'Reset time unknown — watchdog will retry automatically'}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Stability */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconHeartbeat size={16} />
              Stability
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Crashes today</p>
                <p className={cn(
                  'text-2xl font-semibold font-mono',
                  data.crashesToday >= data.maxCrashesPerDay ? 'text-red-500' :
                  data.crashesToday > 0 ? 'text-amber-500' : 'text-foreground',
                )}>
                  {data.crashesToday}
                  <span className="text-sm text-muted-foreground font-normal">/{data.maxCrashesPerDay}</span>
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Restarts today</p>
                <p className="text-2xl font-semibold font-mono">{data.uptime.restartsTodayTotal}</p>
              </div>
            </div>

            {data.uptime.restartsTodayTotal > 0 && (
              <div className="flex flex-wrap gap-2 text-[11px]">
                {data.uptime.restartsType.watchdog > 0 && (
                  <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-orange-600 dark:text-orange-400">
                    {data.uptime.restartsType.watchdog} watchdog
                  </span>
                )}
                {data.uptime.restartsType.crash > 0 && (
                  <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-600 dark:text-red-400">
                    {data.uptime.restartsType.crash} crash
                  </span>
                )}
                {data.uptime.restartsType.self > 0 && (
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400">
                    {data.uptime.restartsType.self} self-restart
                  </span>
                )}
                {data.uptime.restartsType.hard > 0 && (
                  <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-zinc-500">
                    {data.uptime.restartsType.hard} hard
                  </span>
                )}
              </div>
            )}

            {data.uptime.lastRestart && (
              <p className="text-xs text-muted-foreground">
                Last restart: {new Date(data.uptime.lastRestart).toLocaleTimeString()}
              </p>
            )}

            {data.crashesToday === 0 && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <IconCheck size={14} />
                No crashes today
              </div>
            )}
          </CardContent>
        </Card>

        {/* Usage */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconChartBar size={16} />
              Token Usage
              {data.model && (
                <span className="ml-auto text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {data.model}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.usage.weekAllModels ? (
              <UsageBar
                label="Weekly (all models)"
                pct={data.usage.weekAllModels.used_pct}
                resets={data.usage.weekAllModels.resets}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Weekly usage data not available</p>
            )}

            {data.usage.weekSonnet && (
              <UsageBar
                label="Weekly (Sonnet)"
                pct={data.usage.weekSonnet.used_pct}
              />
            )}

            {data.usage.session && (
              <UsageBar
                label="Current session"
                pct={data.usage.session.used_pct}
                resets={data.usage.session.resets}
              />
            )}

            {data.usage.timestamp && (
              <p className="text-[10px] text-muted-foreground/50">
                Last scraped: {new Date(data.usage.timestamp).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
