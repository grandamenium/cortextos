import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BigQuery } from '@google-cloud/bigquery';

export const dynamic = 'force-dynamic';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'click-to-acquire';
const HOURLY_RATE = 50; // Rob's billable rate for agency hours

interface ClientFinanceRow {
  client_id: string;
  name: string;
  retainer: number;         // monthly retainer (your revenue from them)
  managedAdSpend: number;   // pass-through ad spend (their money)
  agencyHours: number;      // estimated hours/mo on this client
  agencyCost: number;       // agencyHours × HOURLY_RATE
  margin: number;           // retainer - agencyCost
  marginPct: number;
}

// Mock retainer + hours — replace with CRM data post-integration
const CLIENT_MOCK: Record<string, { retainer: number; agencyHours: number }> = {
  'oc-repipes':   { retainer: 2_500, agencyHours: 8 },
  'sunny-dental': { retainer: 2_000, agencyHours: 6 },
};
const DEFAULT_MOCK = { retainer: 2_000, agencyHours: 7 };

async function fetchClientFinance(): Promise<ClientFinanceRow[]> {
  let bqRows: Array<{ client_id: string; name: string; ad_spend: number }> = [];

  try {
    const bq = new BigQuery({ projectId: PROJECT });
    const query = `
      SELECT
        c.client_id,
        c.display_name AS name,
        ROUND(COALESCE(SUM(m.spend), 0), 2) AS ad_spend
      FROM \`${PROJECT}.analytics.clients\` c
      LEFT JOIN \`${PROJECT}.analytics.daily_metrics\` m
        ON m.client_id = c.client_id
        AND m.metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
      GROUP BY c.client_id, c.display_name
      ORDER BY c.display_name
      LIMIT 100
    `;
    const [rows] = await bq.query({ query, location: 'US' });
    bqRows = rows as typeof bqRows;
  } catch {
    // BQ unavailable — use mock ad spend
    bqRows = [
      { client_id: 'oc-repipes',   name: 'OC Repipes',    ad_spend: 4_820 },
      { client_id: 'sunny-dental', name: 'Sunny Dental',  ad_spend: 3_200 },
    ];
  }

  return bqRows.map((r) => {
    const mock = CLIENT_MOCK[r.client_id] ?? DEFAULT_MOCK;
    const agencyCost = mock.agencyHours * HOURLY_RATE;
    const margin = mock.retainer - agencyCost;
    const marginPct = mock.retainer > 0 ? Math.round((margin / mock.retainer) * 1000) / 10 : 0;
    return {
      client_id: r.client_id,
      name: r.name,
      retainer: mock.retainer,
      managedAdSpend: r.ad_spend,
      agencyHours: mock.agencyHours,
      agencyCost,
      margin,
      marginPct,
    };
  });
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

export default async function ClientFinancePage() {
  const rows = await fetchClientFinance();
  const totalRetainer    = rows.reduce((s, r) => s + r.retainer, 0);
  const totalAdSpend     = rows.reduce((s, r) => s + r.managedAdSpend, 0);
  const totalAgencyCost  = rows.reduce((s, r) => s + r.agencyCost, 0);
  const totalMargin      = rows.reduce((s, r) => s + r.margin, 0);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Per-Client Finance</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Last 30 days · Ad spend from BQ (live where available) · Retainers and hours mocked
        </p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">
          Retainer = your income. Managed ad spend = client pass-through (their money, not counted in margin).
        </p>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Retainers</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <span className="text-2xl font-bold tabular-nums">{fmt(totalRetainer)}</span>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">your revenue</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Agency Cost</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <span className="text-2xl font-bold tabular-nums">{fmt(totalAgencyCost)}</span>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">hours @ ${HOURLY_RATE}/h</p>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Net Margin</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <span className="text-2xl font-bold tabular-nums text-primary">{fmt(totalMargin)}</span>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">retainer − agency hours</p>
          </CardContent>
        </Card>
        <Card className="border-dashed bg-muted/20">
          <CardHeader className="pb-1 pt-4 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Managed Ad Spend*</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <span className="text-2xl font-bold tabular-nums text-muted-foreground">{fmt(totalAdSpend)}</span>
            <p className="text-[11px] text-muted-foreground/50 mt-0.5">pass-through only</p>
          </CardContent>
        </Card>
      </div>

      {/* Per-client table */}
      <Card>
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm font-medium">Client Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {['Client', 'Retainer', 'Agency Hours', 'Agency Cost', 'Margin', 'Margin %', 'Managed Ad Spend*'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.client_id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(r.retainer)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.agencyHours}h</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{fmt(r.agencyCost)}</td>
                  <td className="px-4 py-2.5 tabular-nums font-medium">{fmt(r.margin)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-emerald-600 dark:text-emerald-400">{r.marginPct}%</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground/60">{fmt(r.managedAdSpend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-muted-foreground/50 border-t">
            * Client pass-through — not included in margin. Live from BQ where available.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
