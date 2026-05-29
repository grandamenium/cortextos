'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BudgetSummary } from '@/lib/data/reports';

interface BudgetPaneProps {
  data: BudgetSummary | null;
}

function BudgetBar({ agent, spent, budget, pct_used, paused }: {
  agent: string;
  spent: number;
  budget: number;
  pct_used: number;
  paused: boolean;
}) {
  const pct = Math.min(Math.round(pct_used * 100), 100);
  const color = paused
    ? 'bg-red-600'
    : pct >= 90
      ? 'bg-red-500'
      : pct >= 75
        ? 'bg-amber-500'
        : pct >= 50
          ? 'bg-yellow-400'
          : 'bg-green-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium font-mono">{agent}{paused ? ' ⏸' : ''}</span>
        <span className="tabular-nums text-muted-foreground">
          ${spent.toFixed(0)} / ${budget.toFixed(0)}
          <span className="ml-2 font-semibold text-foreground">{pct}%</span>
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-[width] duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function BudgetPane({ data }: BudgetPaneProps) {
  if (!data || data.agents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Per-Agent Monthly Budgets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No budget data available. Run the budget-check cron to generate.
          </p>
        </CardContent>
      </Card>
    );
  }

  const pausedCount = data.agents.filter((a) => a.paused).length;
  const overBudgetCount = data.agents.filter((a) => a.pct_used >= 1).length;
  const month = data.month;
  const generatedAt = data.generated_at
    ? new Date(data.generated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Per-Agent Monthly Budgets — {month}
          </CardTitle>
          <div className="flex gap-2 text-xs">
            {pausedCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                {pausedCount} paused
              </span>
            )}
            {overBudgetCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                {overBudgetCount} over budget
              </span>
            )}
          </div>
        </div>
        {generatedAt && (
          <p className="text-[10px] text-muted-foreground">Updated {generatedAt}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {data.agents
            .slice()
            .sort((a, b) => b.pct_used - a.pct_used)
            .map((agent) => (
              <BudgetBar key={agent.agent} {...agent} />
            ))}
        </div>
        <p className="mt-4 text-[10px] text-muted-foreground">
          Alerts at 50% / 75% / 90% → orchestrator. Hard pause at 100% (if enabled in budgets.json).
        </p>
      </CardContent>
    </Card>
  );
}
