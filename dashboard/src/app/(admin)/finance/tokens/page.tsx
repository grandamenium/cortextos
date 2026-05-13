'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

/** Mock daily token burn by agent (last 14 days). Realistic curve: mozart heavy, coder medium. */
function buildMockTokenData() {
  const agents = ['mozart', 'coder', 'picasso', 'sherlock', 'dexter'];
  const palette: Record<string, string> = {
    mozart:   'hsl(221,83%,53%)',
    coder:    'hsl(142,71%,45%)',
    picasso:  'hsl(32,95%,55%)',
    sherlock: 'hsl(271,81%,56%)',
    dexter:   'hsl(199,89%,48%)',
  };
  const baseLoads: Record<string, number> = { mozart: 180000, coder: 120000, picasso: 60000, sherlock: 40000, dexter: 30000 };

  const days: Array<Record<string, unknown>> = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const entry: Record<string, unknown> = { date: label };
    for (const agent of agents) {
      const jitter = 0.6 + Math.random() * 0.8;
      // Weekend dip
      const dow = d.getDay();
      const weekendFactor = (dow === 0 || dow === 6) ? 0.3 : 1.0;
      entry[agent] = Math.round(baseLoads[agent] * jitter * weekendFactor);
    }
    days.push(entry);
  }
  return { days, agents, palette };
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function TokensPage() {
  const { days, agents, palette } = useMemo(() => buildMockTokenData(), []);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const agent of agents) {
      t[agent] = days.reduce((s, d) => s + (d[agent] as number), 0);
    }
    return t;
  }, [days, agents]);

  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Fleet LLM Burn</h1>
        <p className="text-sm text-muted-foreground mt-1">Last 14 days · Mock data · Fleet runs Claude Max plan</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">
          This is an agency ops cost line — AI token usage across all fleet agents. Counted in P&amp;L under &quot;Agency Ops Costs&quot;.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 lg:grid-cols-6">
        <Card className="col-span-3 lg:col-span-1">
          <CardHeader className="pb-1 pt-4 px-4"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total (14d)</CardTitle></CardHeader>
          <CardContent className="px-4 pb-4"><span className="text-2xl font-bold tabular-nums">{fmtTokens(grandTotal)}</span></CardContent>
        </Card>
        {agents.map((agent) => (
          <Card key={agent}>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{agent}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <span className="text-xl font-bold tabular-nums" style={{ color: palette[agent] }}>
                {fmtTokens(totals[agent])}
              </span>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                {Math.round((totals[agent] / grandTotal) * 100)}% of fleet
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Bar chart */}
      <Card>
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm font-medium">Daily Token Burn by Agent</CardTitle>
        </CardHeader>
        <CardContent className="pb-4 pr-6">
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={days} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={fmtTokens} tick={{ fontSize: 11 }} width={48} />
              <Tooltip formatter={(v) => fmtTokens(v as number)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {agents.map((agent) => (
                <Bar key={agent} dataKey={agent} stackId="a" fill={palette[agent]} name={agent} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
