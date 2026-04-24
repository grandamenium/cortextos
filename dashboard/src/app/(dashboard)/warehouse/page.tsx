import {
  getHeadlineMetrics,
  getClientRollup,
  getSpendTrend,
  getAnomalyFlags,
  getDataFreshness,
  getPipelineHealth,
  type HeadlineMetrics,
  type ClientRollup,
  type SpendTrend,
  type AnomalyFlag,
  type DataFreshness,
  type PipelineHealth,
} from '@/lib/data/warehouse';
import { IconDatabase, IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';

function fmt$(n: number | null): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtNum(n: number | null, decimals = 1): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(n);
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ChangeArrow({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground text-xs">—</span>;
  const color = pct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  return <span className={`text-xs font-medium ${color}`}>{fmtPct(pct)}</span>;
}

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    google: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    meta: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  };
  const label = platform === 'google' ? 'Google' : platform === 'meta' ? 'Meta' : platform;
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${colors[platform] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>
      {label}
    </span>
  );
}

function HeadlineCards({ data }: { data: HeadlineMetrics }) {
  const cplChange = data.fleet_cpl_7d != null && data.fleet_cpl_prior_7d != null && data.fleet_cpl_prior_7d > 0
    ? ((data.fleet_cpl_7d - data.fleet_cpl_prior_7d) / data.fleet_cpl_prior_7d) * 100
    : null;
  const ctrChange = data.fleet_ctr_7d != null && data.fleet_ctr_prior_7d != null && data.fleet_ctr_prior_7d > 0
    ? ((data.fleet_ctr_7d - data.fleet_ctr_prior_7d) / data.fleet_ctr_prior_7d) * 100
    : null;

  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Fleet Spend (7d)</p>
        <p className="text-2xl font-semibold mt-1">{fmt$(data.fleet_spend_7d)}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">vs prior 7d: {fmt$(data.fleet_spend_prior_7d)}</span>
          <ChangeArrow pct={data.spend_change_pct} />
        </div>
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Fleet CPL (7d)</p>
        <p className="text-2xl font-semibold mt-1">{fmt$(data.fleet_cpl_7d)}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">vs prior: {fmt$(data.fleet_cpl_prior_7d)}</span>
          <ChangeArrow pct={cplChange} />
        </div>
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Fleet CTR (7d)</p>
        <p className="text-2xl font-semibold mt-1">{data.fleet_ctr_7d != null ? `${data.fleet_ctr_7d.toFixed(2)}%` : '—'}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">vs prior: {data.fleet_ctr_prior_7d != null ? `${data.fleet_ctr_prior_7d.toFixed(2)}%` : '—'}</span>
          <ChangeArrow pct={ctrChange} />
        </div>
      </div>
    </div>
  );
}

function ClientTable({ rows }: { rows: ClientRollup[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
        No client data for yesterday. Check pipeline health below.
      </div>
    );
  }
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left px-4 py-3 font-medium">Client</th>
              <th className="text-left px-4 py-3 font-medium">Platform</th>
              <th className="text-right px-4 py-3 font-medium">Spend (yesterday)</th>
              <th className="text-right px-4 py-3 font-medium">Clicks</th>
              <th className="text-right px-4 py-3 font-medium">CTR %</th>
              <th className="text-right px-4 py-3 font-medium">CPL (yesterday)</th>
              <th className="text-right px-4 py-3 font-medium">CPL (7d)</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 font-medium">{row.display_name}</td>
                <td className="px-4 py-3"><PlatformBadge platform={row.platform} /></td>
                <td className="px-4 py-3 text-right tabular-nums">{fmt$(row.spend_yesterday)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtNum(row.clicks_yesterday, 0)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.ctr_pct != null ? `${row.ctr_pct.toFixed(2)}%` : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmt$(row.cpl_yesterday)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmt$(row.cpl_7d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnomalyPanel({ flags }: { flags: AnomalyFlag[] }) {
  if (flags.length === 0) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-4 text-sm flex items-center gap-2">
        <IconCheck size={16} className="text-green-600 dark:text-green-400" />
        <span className="text-green-800 dark:text-green-300">No anomalies detected</span>
      </div>
    );
  }

  const severityColor: Record<string, string> = {
    SPEND_SPIKE: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 text-red-800 dark:text-red-300',
    SPEND_DROP: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 text-red-800 dark:text-red-300',
    MISSING_DATA: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 text-red-800 dark:text-red-300',
    CTR_COLLAPSE: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300',
    ZERO_SPEND: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300',
  };

  const flagLabels: Record<string, string> = {
    SPEND_SPIKE: 'Spend Spike',
    SPEND_DROP: 'Spend Drop',
    MISSING_DATA: 'Missing Data',
    CTR_COLLAPSE: 'CTR Collapse',
    ZERO_SPEND: 'Zero Spend',
  };

  return (
    <div className="space-y-2">
      {flags.map((f, i) => (
        <div key={i} className={`rounded-lg border p-3 text-sm flex items-center gap-3 ${severityColor[f.flag] ?? ''}`}>
          <IconAlertTriangle size={16} />
          <span className="font-medium">{f.display_name}</span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-white/50 dark:bg-black/20">
            {flagLabels[f.flag] ?? f.flag}
          </span>
          <span className="text-xs opacity-75">{f.detail}</span>
        </div>
      ))}
    </div>
  );
}

function FreshnessTable({ rows }: { rows: DataFreshness[] }) {
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left px-4 py-2 font-medium text-xs">Client</th>
              <th className="text-left px-4 py-2 font-medium text-xs">Platform</th>
              <th className="text-left px-4 py-2 font-medium text-xs">Latest Date</th>
              <th className="text-right px-4 py-2 font-medium text-xs">Staleness</th>
              <th className="text-right px-4 py-2 font-medium text-xs">Total Days</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-muted/20">
                <td className="px-4 py-2 text-xs">{row.display_name}</td>
                <td className="px-4 py-2 text-xs"><PlatformBadge platform={row.platform} /></td>
                <td className="px-4 py-2 text-xs tabular-nums">{row.latest_date}</td>
                <td className={`px-4 py-2 text-xs text-right tabular-nums ${row.days_stale > 1 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-green-600 dark:text-green-400'}`}>
                  {row.days_stale === 0 ? 'today' : `${row.days_stale}d`}
                </td>
                <td className="px-4 py-2 text-xs text-right tabular-nums text-muted-foreground">{row.total_dates}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PipelineHealthPanel({ pipelines }: { pipelines: PipelineHealth[] }) {
  if (pipelines.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-4">
      {pipelines.map((p) => (
        <div key={p.pipeline} className="rounded-lg border p-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{p.pipeline}</p>
            <p className="text-xs text-muted-foreground">{p.last_row_count} rows &middot; {timeAgo(p.last_run_at)}</p>
          </div>
          {p.last_error ? (
            <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <IconX size={14} /> Error
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <IconCheck size={14} /> Healthy
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default async function WarehousePage() {
  let error: string | null = null;
  let headlines: HeadlineMetrics | null = null;
  let clients: ClientRollup[] = [];
  let _trend: SpendTrend[] = [];
  let anomalies: AnomalyFlag[] = [];
  let freshness: DataFreshness[] = [];
  let pipelines: PipelineHealth[] = [];

  try {
    [headlines, clients, _trend, anomalies, freshness] = await Promise.all([
      getHeadlineMetrics(),
      getClientRollup(),
      getSpendTrend(),
      getAnomalyFlags(),
      getDataFreshness(),
    ]);
    pipelines = getPipelineHealth();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <IconDatabase size={24} />
          Warehouse
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live client performance data from BigQuery
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 p-4 text-sm text-red-800 dark:text-red-300">
          Failed to query BigQuery: {error}
        </div>
      ) : (
        <>
          {headlines && <HeadlineCards data={headlines} />}

          <div>
            <h2 className="text-lg font-medium mb-3">Anomalies</h2>
            <AnomalyPanel flags={anomalies} />
          </div>

          <div>
            <h2 className="text-lg font-medium mb-3">Per-Client Performance (Yesterday)</h2>
            <ClientTable rows={clients} />
          </div>

          <div>
            <h2 className="text-lg font-medium mb-3">Pipeline Health</h2>
            <PipelineHealthPanel pipelines={pipelines} />
          </div>

          <div>
            <h2 className="text-lg font-medium mb-3">Data Freshness</h2>
            <FreshnessTable rows={freshness} />
          </div>
        </>
      )}
    </div>
  );
}
