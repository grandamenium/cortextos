import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SourceCohortRow } from '@/lib/data/skool';

interface Props {
  rows: SourceCohortRow[];
}

function retentionColor(pct: number | null): string {
  if (pct == null) return 'bg-muted/20';
  if (pct >= 85) return 'bg-green-500/40';
  if (pct >= 70) return 'bg-green-500/25';
  if (pct >= 50) return 'bg-amber-500/30';
  if (pct >= 30) return 'bg-amber-500/15';
  return 'bg-red-500/25';
}

function fmtUsd(n: number | null) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function SourceCohortHeatmap({ rows }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention by acquisition source</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="source-cohort-empty">
            No acquisition-source data yet.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="source-cohort-heatmap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Source</th>
                  <th className="text-right py-2 font-medium">Cohort</th>
                  <th className="text-right py-2 font-medium">Still paying</th>
                  <th className="text-right py-2 font-medium">Retention %</th>
                  <th className="text-right py-2 font-medium">Churned</th>
                  <th className="text-right py-2 font-medium">Avg days to churn</th>
                  <th className="text-right py-2 font-medium">Est. LTV</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.source} className="border-b last:border-0" data-testid="source-cohort-row" data-source={r.source}>
                    <td className="py-2 font-medium">{r.source}</td>
                    <td className="py-2 text-right tabular-nums">{r.cohort_size}</td>
                    <td className="py-2 text-right tabular-nums">{r.still_paying}</td>
                    <td className="py-2 text-right tabular-nums">
                      <span className={`inline-block px-2 py-0.5 rounded ${retentionColor(r.retention_pct)}`}>
                        {r.retention_pct != null ? `${Number(r.retention_pct).toFixed(1)}%` : '—'}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{r.churned}</td>
                    <td className="py-2 text-right tabular-nums">
                      {r.avg_days_to_churn != null ? Number(r.avg_days_to_churn).toFixed(0) : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtUsd(r.estimated_ltv_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-3">
              Cohort = all members ever from this source (active + cancelling + churned). Retention % = (active + cancelling) / cohort. Green = sticky channel, red = leaky channel.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
