import { MOCK_PNL, getPnLSummary, AGENCY_OPS_COSTS } from '@/lib/finance/mock-pnl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function TrendBadge({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const positive = invert ? pct <= 0 : pct >= 0;
  return (
    <Badge variant={positive ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
      {pct >= 0 ? '+' : ''}{pct}%
    </Badge>
  );
}

export default function PnLPage() {
  const s = getPnLSummary();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agency P&amp;L</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Jan–May 2026 · Mock data · QuickBooks OAuth pending
        </p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">
          Revenue = client retainers (your money). Costs = agency ops only. Client ad spend is pass-through — not your money, not counted here.
        </p>
      </div>

      {/* KPI cards — your money */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Retainer Revenue</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold tabular-nums">{fmt(s.revenue.value)}</span>
              <TrendBadge pct={s.revenue.pct} />
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">vs prior month · your income</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Agency Ops Costs</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold tabular-nums">{fmt(s.costs.value)}</span>
              <TrendBadge pct={s.costs.pct} invert />
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">AI · APIs · software · time</p>
          </CardContent>
        </Card>

        <Card className="border-primary/30">
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Net Margin</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold tabular-nums text-primary">{fmt(s.margin.value)}</span>
              <TrendBadge pct={s.margin.pct} />
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">{s.margin_pct}% margin · retainer − ops</p>
          </CardContent>
        </Card>
      </div>

      {/* Pass-through callout — NOT in P&L */}
      <Card className="border-dashed bg-muted/20">
        <CardContent className="px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Managed Ad Spend (pass-through)</p>
            <p className="text-xs text-muted-foreground/60 mt-0.5">Client money flowing through accounts — not your revenue or cost</p>
          </div>
          <div className="text-right">
            <span className="text-xl font-bold tabular-nums text-muted-foreground">{fmt(s.managedAdSpend.value)}</span>
            <p className="text-[11px] text-muted-foreground/50">/mo · informational only</p>
          </div>
        </CardContent>
      </Card>

      {/* Monthly table */}
      <Card>
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm font-medium">Monthly Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {['Month', 'Retainer Revenue', 'Agency Costs', 'Net Margin', 'Margin %', 'Managed Ad Spend*'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...MOCK_PNL].reverse().map((row) => (
                <tr key={row.month} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{row.label}</td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(row.revenue)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{fmt(row.costs)}</td>
                  <td className="px-4 py-2.5 tabular-nums font-medium">{fmt(row.margin)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {Math.round((row.margin / row.revenue) * 100)}%
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground/60">{fmt(row.managedAdSpend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-muted-foreground/50 border-t">* Pass-through only — not included in margin calculation</p>
        </CardContent>
      </Card>

      {/* Agency ops cost breakdown */}
      <Card>
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm font-medium">Agency Ops Cost Breakdown (current month)</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {['Line Item', 'Category', 'Monthly'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AGENCY_OPS_COSTS.map((c) => (
                <tr key={c.name} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2 font-medium">{c.name}</td>
                  <td className="px-4 py-2 text-muted-foreground capitalize">{c.category}</td>
                  <td className="px-4 py-2 tabular-nums">{fmt(c.monthly)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
