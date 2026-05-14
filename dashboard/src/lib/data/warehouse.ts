// Query contract: return aggregated rows, never raw event/metric data.
// All queries must use GROUP BY + aggregate functions, filter on date partition,
// and LIMIT to max 100 rows. No SELECT * from daily_metrics. — Rob 2026-04-24
//
// Date semantics: queries anchor on MAX(metric_date) in daily_metrics, not
// CURRENT_DATE(). Ingest runs at 07:30 UTC and writes "yesterday" data, so
// CURRENT_DATE() - 1 is ahead of the latest available row for ~7h each day.
// Using the actual latest date eliminates the false "Missing Data" flag.
import { BigQuery } from '@google-cloud/bigquery';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let bqClient: BigQuery | null = null;

function getBQ(): BigQuery {
  if (bqClient) return bqClient;
  const keyPath = join(homedir(), '.cortextos', 'secrets', 'bigquery-key.json');
  const credentials = JSON.parse(readFileSync(keyPath, 'utf-8'));
  bqClient = new BigQuery({ projectId: 'click-to-acquire', credentials });
  return bqClient;
}

async function query<T>(sql: string): Promise<T[]> {
  const [rows] = await getBQ().query({ query: sql, location: 'US' });
  return rows as T[];
}

let latestDateCache: { date: string; cachedAt: number } | null = null;

async function getLatestMetricDate(): Promise<string> {
  if (latestDateCache && Date.now() - latestDateCache.cachedAt < 60_000) {
    return latestDateCache.date;
  }
  const rows = await query<{ latest: { value: string } | string }>(`
    SELECT FORMAT_DATE('%Y-%m-%d', MAX(metric_date)) AS latest
    FROM \`click-to-acquire.analytics.daily_metrics\`
    WHERE entity_type = 'campaign'
      AND metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  `);
  const raw = rows[0]?.latest;
  const date = typeof raw === 'string' ? raw : raw?.value;
  if (!date) throw new Error('No metric_date found in last 30 days');
  latestDateCache = { date, cachedAt: Date.now() };
  return date;
}

// --- Section 1: Headline Metrics ---

export interface HeadlineMetrics {
  fleet_spend_7d: number;
  fleet_spend_prior_7d: number;
  spend_change_pct: number | null;
  fleet_cpl_7d: number | null;
  fleet_cpl_prior_7d: number | null;
  fleet_ctr_7d: number | null;
  fleet_ctr_prior_7d: number | null;
}

export async function getHeadlineMetrics(): Promise<HeadlineMetrics> {
  const latest = await getLatestMetricDate();
  const rows = await query<HeadlineMetrics>(`
    WITH current_7d AS (
      SELECT SUM(spend) AS spend, SUM(impressions) AS impressions,
             SUM(clicks) AS clicks, SUM(conversions) AS conversions
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE entity_type = 'campaign'
        AND metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 6 DAY)
                            AND DATE '${latest}'
        AND client_id != 'test-smoke-n8n'
    ),
    prior_7d AS (
      SELECT SUM(spend) AS spend, SUM(impressions) AS impressions,
             SUM(clicks) AS clicks, SUM(conversions) AS conversions
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE entity_type = 'campaign'
        AND metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 13 DAY)
                            AND DATE_SUB(DATE '${latest}', INTERVAL 7 DAY)
        AND client_id != 'test-smoke-n8n'
    )
    SELECT
      c.spend AS fleet_spend_7d,
      p.spend AS fleet_spend_prior_7d,
      SAFE_DIVIDE(c.spend - p.spend, p.spend) * 100 AS spend_change_pct,
      SAFE_DIVIDE(c.spend, c.conversions) AS fleet_cpl_7d,
      SAFE_DIVIDE(p.spend, p.conversions) AS fleet_cpl_prior_7d,
      SAFE_DIVIDE(c.clicks, c.impressions) * 100 AS fleet_ctr_7d,
      SAFE_DIVIDE(p.clicks, p.impressions) * 100 AS fleet_ctr_prior_7d
    FROM current_7d c, prior_7d p
    LIMIT 1
  `);
  return rows[0] ?? {
    fleet_spend_7d: 0, fleet_spend_prior_7d: 0, spend_change_pct: null,
    fleet_cpl_7d: null, fleet_cpl_prior_7d: null,
    fleet_ctr_7d: null, fleet_ctr_prior_7d: null,
  };
}

// --- Section 2: Per-Client Rollup ---

export interface ClientRollup {
  display_name: string;
  client_id: string;
  platform: string;
  spend_yesterday: number;
  clicks_yesterday: number;
  ctr_pct: number | null;
  cpl_yesterday: number | null;
  cpl_7d: number | null;
}

export async function getClientRollup(): Promise<ClientRollup[]> {
  const latest = await getLatestMetricDate();
  return query<ClientRollup>(`
    WITH latest_day AS (
      SELECT client_id, platform,
             SUM(spend) AS spend_yesterday,
             SUM(clicks) AS clicks_yesterday,
             SAFE_DIVIDE(SUM(clicks), SUM(impressions)) * 100 AS ctr_pct,
             SAFE_DIVIDE(SUM(spend), NULLIF(SUM(conversions), 0)) AS cpl_yesterday
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE entity_type = 'campaign'
        AND metric_date = DATE '${latest}'
      GROUP BY client_id, platform
    ),
    rolling AS (
      SELECT client_id,
             SAFE_DIVIDE(SUM(spend), NULLIF(SUM(conversions), 0)) AS cpl_7d
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE entity_type = 'campaign'
        AND metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 6 DAY)
                            AND DATE '${latest}'
      GROUP BY client_id
    )
    SELECT
      COALESCE(cl.display_name, y.client_id) AS display_name,
      y.client_id, y.platform,
      ROUND(y.spend_yesterday, 2) AS spend_yesterday,
      y.clicks_yesterday,
      ROUND(y.ctr_pct, 2) AS ctr_pct,
      ROUND(y.cpl_yesterday, 2) AS cpl_yesterday,
      ROUND(r.cpl_7d, 2) AS cpl_7d
    FROM latest_day y
    LEFT JOIN \`click-to-acquire.analytics.clients\` cl USING (client_id)
    LEFT JOIN rolling r USING (client_id)
    ORDER BY y.spend_yesterday DESC
    LIMIT 50
  `);
}

// --- Section 3: Spend Trend (30d) ---

export interface SpendTrend {
  metric_date: string;
  display_name: string;
  daily_spend: number;
}

export async function getSpendTrend(): Promise<SpendTrend[]> {
  const latest = await getLatestMetricDate();
  return query<SpendTrend>(`
    SELECT
      FORMAT_DATE('%Y-%m-%d', dm.metric_date) AS metric_date,
      COALESCE(cl.display_name, dm.client_id) AS display_name,
      ROUND(SUM(dm.spend), 2) AS daily_spend
    FROM \`click-to-acquire.analytics.daily_metrics\` dm
    LEFT JOIN \`click-to-acquire.analytics.clients\` cl USING (client_id)
    WHERE dm.entity_type = 'campaign'
      AND dm.metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 29 DAY)
                             AND DATE '${latest}'
    GROUP BY dm.metric_date, display_name
    ORDER BY dm.metric_date, display_name
    LIMIT 150
  `);
}

// --- Section 4: Anomaly Flags ---

export interface AnomalyFlag {
  display_name: string;
  flag: string;
  detail: string;
}

export async function getAnomalyFlags(): Promise<AnomalyFlag[]> {
  const latest = await getLatestMetricDate();
  const flags: AnomalyFlag[] = [];

  const spendAnomalies = await query<{
    display_name: string; yesterday_spend: number;
    avg_7d_spend: number; flag: string;
  }>(`
    WITH daily AS (
      SELECT client_id, metric_date, SUM(spend) AS daily_spend
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE entity_type = 'campaign'
        AND metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 7 DAY)
                            AND DATE '${latest}'
      GROUP BY client_id, metric_date
    ),
    avg_7d AS (
      SELECT client_id, AVG(daily_spend) AS avg_spend
      FROM daily WHERE metric_date < DATE '${latest}'
      GROUP BY client_id
    ),
    latest_day AS (
      SELECT client_id, daily_spend
      FROM daily WHERE metric_date = DATE '${latest}'
    )
    SELECT
      COALESCE(cl.display_name, y.client_id) AS display_name,
      ROUND(y.daily_spend, 2) AS yesterday_spend,
      ROUND(a.avg_spend, 2) AS avg_7d_spend,
      CASE
        WHEN y.daily_spend > a.avg_spend * 1.5 THEN 'SPEND_SPIKE'
        WHEN y.daily_spend < a.avg_spend * 0.5 THEN 'SPEND_DROP'
      END AS flag
    FROM latest_day y
    JOIN avg_7d a USING (client_id)
    LEFT JOIN \`click-to-acquire.analytics.clients\` cl USING (client_id)
    WHERE y.daily_spend > a.avg_spend * 1.5 OR y.daily_spend < a.avg_spend * 0.5
    LIMIT 20
  `);
  for (const r of spendAnomalies) {
    flags.push({
      display_name: r.display_name,
      flag: r.flag,
      detail: `$${r.yesterday_spend} on ${latest} vs $${r.avg_7d_spend} avg`,
    });
  }

  // Only flag MISSING_DATA for clients that have been active in the last 14
  // days but are absent on the latest date. This excludes offboarded clients
  // (FR Kitchen etc.) and never-active rows, while still catching real gaps.
  const missingData = await query<{ display_name: string }>(`
    WITH active_recently AS (
      SELECT DISTINCT client_id
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 13 DAY)
                            AND DATE '${latest}'
        AND client_id != 'test-smoke-n8n'
    ),
    on_latest AS (
      SELECT DISTINCT client_id
      FROM \`click-to-acquire.analytics.daily_metrics\`
      WHERE metric_date = DATE '${latest}'
    )
    SELECT COALESCE(cl.display_name, a.client_id) AS display_name
    FROM active_recently a
    LEFT JOIN on_latest o USING (client_id)
    LEFT JOIN \`click-to-acquire.analytics.clients\` cl USING (client_id)
    WHERE o.client_id IS NULL
    LIMIT 20
  `);
  for (const r of missingData) {
    flags.push({
      display_name: r.display_name,
      flag: 'MISSING_DATA',
      detail: `No data for ${latest}`,
    });
  }

  return flags;
}

// --- Section 5: Data Freshness ---

export interface DataFreshness {
  display_name: string;
  platform: string;
  latest_date: string;
  days_stale: number;
  total_dates: number;
}

export async function getDataFreshness(): Promise<DataFreshness[]> {
  const latest = await getLatestMetricDate();
  return query<DataFreshness>(`
    SELECT
      COALESCE(cl.display_name, dm.client_id) AS display_name,
      dm.platform,
      FORMAT_DATE('%Y-%m-%d', MAX(dm.metric_date)) AS latest_date,
      DATE_DIFF(DATE '${latest}', MAX(dm.metric_date), DAY) AS days_stale,
      COUNT(DISTINCT dm.metric_date) AS total_dates
    FROM \`click-to-acquire.analytics.daily_metrics\` dm
    LEFT JOIN \`click-to-acquire.analytics.clients\` cl USING (client_id)
    WHERE dm.entity_type = 'campaign'
      AND dm.metric_date BETWEEN DATE_SUB(DATE '${latest}', INTERVAL 89 DAY)
                             AND DATE '${latest}'
    GROUP BY display_name, dm.platform
    ORDER BY display_name, dm.platform
    LIMIT 50
  `);
}

// --- Pipeline Health (from agent state files) ---

export interface PipelineHealth {
  pipeline: string;
  last_run_at: string | null;
  last_row_count: number;
  last_error: string | null;
}

export function getPipelineHealth(): PipelineHealth[] {
  const pipelines: PipelineHealth[] = [];
  const ctxRoot = join(homedir(), '.cortextos', 'default');

  for (const agent of ['googli', 'methy']) {
    const path = join(ctxRoot, 'state', agent, 'pipeline-status.json');
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        pipelines.push({
          pipeline: data.pipeline ?? agent,
          last_run_at: data.last_run_at ?? null,
          last_row_count: data.last_row_count ?? 0,
          last_error: data.last_error ?? null,
        });
      } catch { /* skip malformed */ }
    }
  }

  return pipelines;
}
