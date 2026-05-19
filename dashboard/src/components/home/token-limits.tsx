import { Card, CardContent } from '@/components/ui/card';
import { SparkLine } from '@/components/charts/spark-line';
import type { TokenLimitsSnapshot } from '@/lib/token-usage';

interface TokenLimitsProps {
  usage: TokenLimitsSnapshot;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatResetLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function percent(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((value / cap) * 100));
}

export function TokenLimits({ usage }: TokenLimitsProps) {
  return (
    <Card className="border-none bg-white py-0 shadow-sm ring-1 ring-slate-200">
      <CardContent className="space-y-5 px-5 py-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Token limits</h2>
          <p className="mt-1 text-sm text-slate-600">Five-hour guardrails, weekly pace, and today’s burn in one place.</p>
        </div>

        {usage.source === 'fallback' && (
          <div
            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="limits-source-fallback"
          >
            Fallback mode — using local token logs because the Anthropic admin key is unavailable.
          </div>
        )}

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">5-hour window</p>
            <p className="text-xs text-slate-500" data-testid="limits-5h-reset">{formatResetLabel(usage.fiveHour.resetAt)}</p>
          </div>
          <div className="flex items-end justify-between gap-3">
            <p className="text-2xl font-semibold text-slate-900" data-testid="limits-5h-used">
              {formatTokens(usage.fiveHour.used)}
            </p>
            <p className="text-sm text-slate-500" data-testid="limits-5h-cap">
              / {usage.fiveHour.cap.toLocaleString()}
            </p>
          </div>
          <div className="h-2 rounded-full bg-slate-200">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500"
              style={{ width: `${percent(usage.fiveHour.used, usage.fiveHour.cap)}%` }}
            />
          </div>
          <div className="space-y-1 text-xs text-slate-500">
            {usage.fiveHour.byAgent.map((agent) => (
              <div className="flex items-center justify-between" key={agent.agent}>
                <span>@{agent.agent}</span>
                <span>{formatTokens(agent.tokens)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">Weekly window</p>
            <p className="text-xs text-slate-500" data-testid="limits-weekly-reset">{formatResetLabel(usage.weekly.resetAt)}</p>
          </div>
          <div className="flex items-end justify-between gap-3">
            <p className="text-2xl font-semibold text-slate-900" data-testid="limits-weekly-used">
              {formatTokens(usage.weekly.used)}
            </p>
            <p className="text-sm text-slate-500" data-testid="limits-weekly-cap">
              / {usage.weekly.cap.toLocaleString()}
            </p>
          </div>
          <div className="relative h-2 rounded-full bg-slate-200">
            <div
              className="h-2 rounded-full bg-slate-900"
              style={{ width: `${percent(usage.weekly.used, usage.weekly.cap)}%` }}
            />
            <div
              className="absolute inset-y-[-4px] w-px bg-amber-500"
              style={{ left: `${Math.max(0, Math.min(100, usage.weekly.pace * 100))}%` }}
            />
          </div>
          <p className="text-xs text-slate-500" data-testid="limits-weekly-pace">
            Pace marker at {Math.round(usage.weekly.pace * 100)}%
          </p>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">24h burn</p>
            <p className="text-xs text-slate-500">{formatDollars(usage.burn24h.dollars)}</p>
          </div>
          <SparkLine data={usage.burn24h.points} width={240} height={48} className="w-full" />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{formatTokens(usage.burn24h.tokens)} tokens</span>
            <span>Trailing read-out</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
