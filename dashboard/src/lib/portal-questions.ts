/**
 * BQ aggregate implementations for the client portal 13-question catalog
 * (PHASES Task 9.2). Spec lives in @cta-platform/portal-questions.
 *
 * All queries: aggregate-only, partition-filtered, LIMIT ≤ 100.
 */

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'click-to-acquire';
const DATASET = 'analytics';
const CTA_DATASET = 'cta_platform';

function getBQ(): BigQuery {
  return new BigQuery({ projectId: PROJECT });
}

export interface DateRange {
  start: string;
  end: string;
}

export type Platform = 'google' | 'meta' | 'bing' | 'tiktok' | 'linkedin' | 'other';

function rangeDays(range: DateRange): number {
  const ms = Date.parse(range.end) - Date.parse(range.start);
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

function priorRange(range: DateRange): DateRange {
  const days = rangeDays(range);
  const startMs = Date.parse(range.start) - days * 86_400_000;
  const endMs = Date.parse(range.start) - 1;
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(endMs).toISOString().slice(0, 10),
  };
}

// Q1 — spend
export async function getClientSpend(
  clientId: string,
  range: DateRange,
): Promise<{
  spend_total: number;
  daily: Array<{ date: string; spend: number }>;
  by_platform: Record<Platform, number>;
}> {
  const bq = getBQ();
  const query = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', metric_date) AS date,
      platform,
      ROUND(SUM(spend), 2) AS spend
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date BETWEEN @start AND @end
    GROUP BY metric_date, platform
    ORDER BY metric_date ASC
    LIMIT 100
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });
  const dailyMap = new Map<string, number>();
  const byPlatform: Record<string, number> = {};
  let total = 0;
  for (const r of rows as Array<{ date: string; platform: string; spend: number }>) {
    dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + r.spend);
    byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + r.spend;
    total += r.spend;
  }
  return {
    spend_total: round2(total),
    daily: Array.from(dailyMap.entries(), ([date, spend]) => ({ date, spend: round2(spend) })),
    by_platform: byPlatform as Record<Platform, number>,
  };
}

// Q2 — revenue (conversion value)
export async function getClientRevenue(
  clientId: string,
  range: DateRange,
): Promise<{
  revenue_total: number;
  daily: Array<{ date: string; revenue: number }>;
  roas: number;
}> {
  const bq = getBQ();
  const query = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', metric_date) AS date,
      ROUND(SUM(conversion_value), 2) AS revenue,
      ROUND(SUM(spend), 2) AS spend
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date BETWEEN @start AND @end
    GROUP BY metric_date
    ORDER BY metric_date ASC
    LIMIT 100
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });
  let revenueTotal = 0;
  let spendTotal = 0;
  const daily: Array<{ date: string; revenue: number }> = [];
  for (const r of rows as Array<{ date: string; revenue: number; spend: number }>) {
    revenueTotal += r.revenue ?? 0;
    spendTotal += r.spend ?? 0;
    daily.push({ date: r.date, revenue: round2(r.revenue ?? 0) });
  }
  return {
    revenue_total: round2(revenueTotal),
    daily,
    roas: spendTotal > 0 ? round2(revenueTotal / spendTotal) : 0,
  };
}

// Q3 — cost per customer (CPA)
export async function getClientCpa(
  clientId: string,
  range: DateRange,
): Promise<{ avg_cpa: number; pct_change: number; trend: 'up' | 'down' | 'flat'; daily: Array<{ date: string; cpa: number }> }> {
  const bq = getBQ();
  const dailyQuery = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', metric_date) AS date,
      SUM(spend) AS spend,
      SUM(conversions) AS conversions
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date BETWEEN @start AND @end
    GROUP BY metric_date
    ORDER BY metric_date ASC
    LIMIT 100
  `;
  const [rows] = await bq.query({
    query: dailyQuery,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });
  const dailyData = (rows as Array<{ date: string; spend: number; conversions: number }>).map((r) => ({
    date: r.date,
    cpa: r.conversions > 0 ? round2(r.spend / r.conversions) : 0,
  }));
  const totalSpend = (rows as Array<{ spend: number }>).reduce((a, r) => a + (r.spend ?? 0), 0);
  const totalConv = (rows as Array<{ conversions: number }>).reduce((a, r) => a + (r.conversions ?? 0), 0);
  const avgCpa = totalConv > 0 ? totalSpend / totalConv : 0;

  const prior = priorRange(range);
  const [priorRows] = await bq.query({
    query: dailyQuery,
    location: 'US',
    params: { clientId, start: prior.start, end: prior.end },
  });
  const priorSpend = (priorRows as Array<{ spend: number }>).reduce((a, r) => a + (r.spend ?? 0), 0);
  const priorConv = (priorRows as Array<{ conversions: number }>).reduce((a, r) => a + (r.conversions ?? 0), 0);
  const priorCpa = priorConv > 0 ? priorSpend / priorConv : 0;

  const pctChange = priorCpa > 0 ? round2(((avgCpa - priorCpa) / priorCpa) * 100) : 0;
  const trend: 'up' | 'down' | 'flat' = Math.abs(pctChange) < 5 ? 'flat' : pctChange > 0 ? 'up' : 'down';
  return { avg_cpa: round2(avgCpa), pct_change: pctChange, trend, daily: dailyData };
}

// Q4 — CPA vs target
export async function getCpaVsTarget(
  clientId: string,
  range: DateRange,
): Promise<{ target_cpa: number; actual_cpa: number; status: 'on_target' | 'above' | 'below' }> {
  const bq = getBQ();
  const targetQuery = `
    SELECT cpl_target
    FROM \`${PROJECT}.${DATASET}.clients\`
    WHERE client_id = @clientId
    LIMIT 1
  `;
  const [targetRows] = await bq.query({
    query: targetQuery,
    location: 'US',
    params: { clientId },
  });
  const target = (targetRows[0] as { cpl_target: number | null } | undefined)?.cpl_target ?? 0;

  const cpaResult = await getClientCpa(clientId, range);
  const actual = cpaResult.avg_cpa;
  const status: 'on_target' | 'above' | 'below' =
    target === 0 ? 'on_target' : Math.abs(actual - target) / target < 0.1 ? 'on_target' : actual > target ? 'above' : 'below';
  return { target_cpa: round2(target), actual_cpa: round2(actual), status };
}

// Q5 — leads
export async function getClientLeads(
  clientId: string,
  range: DateRange,
): Promise<{ lead_count: number; qualified_count: number; daily: Array<{ date: string; leads: number }> }> {
  const bq = getBQ();
  // qualified_conversions column does not exist in daily_metrics — stub to 0
  const query = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', metric_date) AS date,
      SUM(conversions) AS leads
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date BETWEEN @start AND @end
    GROUP BY metric_date
    ORDER BY metric_date ASC
    LIMIT 100
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });
  const daily = (rows as Array<{ date: string; leads: number }>).map((r) => ({
    date: r.date,
    leads: r.leads ?? 0,
  }));
  const total = daily.reduce((a, r) => a + r.leads, 0);
  return { lead_count: total, qualified_count: 0, daily };
}

// Q6 — lead growth
export async function getLeadGrowth(
  clientId: string,
  range: DateRange,
): Promise<{ pct_change: number; trend: 'growing' | 'shrinking' | 'flat'; rolling_14d: Array<{ date: string; leads: number }> }> {
  const current = await getClientLeads(clientId, range);
  const prior = await getClientLeads(clientId, priorRange(range));
  const pct = prior.lead_count > 0 ? round2(((current.lead_count - prior.lead_count) / prior.lead_count) * 100) : 0;
  const trend: 'growing' | 'shrinking' | 'flat' = Math.abs(pct) < 5 ? 'flat' : pct > 0 ? 'growing' : 'shrinking';
  return { pct_change: pct, trend, rolling_14d: current.daily.slice(-14) };
}

// Q7 — best campaign (by campaign_id — no campaign_name column in daily_metrics)
export async function getBestCampaign(
  clientId: string,
  range: DateRange,
): Promise<{
  best_campaign_name: string;
  best_roas: number;
  top_5: Array<{ name: string; roas: number; spend: number }>;
}> {
  const bq = getBQ();
  const query = `
    SELECT
      campaign_id AS name,
      SUM(spend) AS spend,
      SUM(conversion_value) AS revenue
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date BETWEEN @start AND @end
      AND campaign_id IS NOT NULL
    GROUP BY campaign_id
    HAVING spend > 0
    ORDER BY revenue / NULLIF(spend, 0) DESC
    LIMIT 5
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });
  const top5 = (rows as Array<{ name: string; spend: number; revenue: number }>).map((r) => ({
    name: r.name,
    spend: round2(r.spend),
    roas: r.spend > 0 ? round2((r.revenue ?? 0) / r.spend) : 0,
  }));
  const best = top5[0] ?? { name: 'no campaigns yet', roas: 0 };
  return { best_campaign_name: best.name, best_roas: best.roas ?? 0, top_5: top5 };
}

// Q8 — best creative — Phase 6 creative pipeline complete; ad-level BQ table not yet created.
// Returns empty response so portal renders gracefully (no throw).
export async function getBestCreative(
  _clientId: string,
  _range: DateRange,
): Promise<{
  best_creative_id: string;
  best_creative_name: string;
  best_creative_format: 'image' | 'video' | 'carousel';
  cvr: number;
  top_3: Array<{ id: string; name: string; cvr: number }>;
}> {
  return {
    best_creative_id: '',
    best_creative_name: 'No ad-level data yet',
    best_creative_format: 'image',
    cvr: 0,
    top_3: [],
  };
}

// Q9 — wasted spend — campaigns with spend > 0 and zero conversions in the date range.
// Phase 8 auto-action thresholds complete; uses daily_metrics as data source.
export async function getWastedSpend(
  clientId: string,
  range: DateRange,
): Promise<{ wasted_amount: number; pct_of_total: number; top_offenders: Array<{ campaign: string; wasted: number }> }> {
  const bq = getBQ();
  const query = `
    WITH by_campaign AS (
      SELECT
        COALESCE(campaign_id, 'unknown') AS campaign,
        ROUND(SUM(spend), 2) AS wasted,
        SUM(conversions) AS conversions
      FROM \`${PROJECT}.${DATASET}.daily_metrics\`
      WHERE client_id = @clientId
        AND metric_date BETWEEN @start AND @end
      GROUP BY campaign_id
    )
    SELECT
      campaign,
      wasted,
      conversions,
      (SELECT ROUND(SUM(wasted), 2) FROM by_campaign) AS total_spend
    FROM by_campaign
    WHERE conversions = 0 AND wasted > 0
    ORDER BY wasted DESC
    LIMIT 20
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId, start: range.start, end: range.end },
  });

  const offenders = (rows as Array<{ campaign: string; wasted: number; total_spend: number }>).map((r) => ({
    campaign: r.campaign,
    wasted: round2(r.wasted ?? 0),
  }));
  const wastedAmount = offenders.reduce((a, r) => a + r.wasted, 0);

  const totalRow = (rows as Array<{ total_spend: number }>)[0];
  const totalSpend = totalRow?.total_spend ?? 0;
  const pct = totalSpend > 0 ? round2((wastedAmount / totalSpend) * 100) : 0;

  return { wasted_amount: round2(wastedAmount), pct_of_total: pct, top_offenders: offenders };
}

// Q10 — month pace
export async function getMonthPace(
  clientId: string,
): Promise<{
  pct_to_goal: number;
  goal_type: 'leads' | 'revenue' | 'spend';
  goal_value: number;
  current_value: number;
  days_remaining: number;
}> {
  const bq = getBQ();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const start = monthStart.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  // primary_goal_type column does not exist — use primary_funnel_type
  const clientQuery = `
    SELECT monthly_budget, primary_funnel_type
    FROM \`${PROJECT}.${DATASET}.clients\`
    WHERE client_id = @clientId
    LIMIT 1
  `;
  const [clientRows] = await bq.query({
    query: clientQuery,
    location: 'US',
    params: { clientId },
  });
  const client = (clientRows[0] as { monthly_budget: number | null; primary_funnel_type: string | null } | undefined) ?? {
    monthly_budget: null,
    primary_funnel_type: null,
  };
  const goalType = (client.primary_funnel_type as 'leads' | 'revenue' | 'spend' | null) ?? 'spend';
  const goalValue = client.monthly_budget ?? 0;

  const range: DateRange = { start, end };
  let currentValue = 0;
  if (goalType === 'spend') currentValue = (await getClientSpend(clientId, range)).spend_total;
  else if (goalType === 'revenue') currentValue = (await getClientRevenue(clientId, range)).revenue_total;
  else currentValue = (await getClientLeads(clientId, range)).lead_count;

  const today = new Date();
  const lastDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const daysRemaining = Math.max(0, Math.ceil((lastDay.getTime() - today.getTime()) / 86_400_000));
  const pct = goalValue > 0 ? round2((currentValue / goalValue) * 100) : 0;
  return { pct_to_goal: pct, goal_type: goalType, goal_value: goalValue, current_value: round2(currentValue), days_remaining: daysRemaining };
}

// Q11 — active tests — Phase 8 GrowthBook integration complete.
// Reads lp_experiments (running) + latest allocations from cta_platform dataset.
export async function getActiveTests(
  clientId: string,
): Promise<{ active_test_count: number; leading_variant: string; tests: Array<{ id: string; variants: number; leading_p_best: number }> }> {
  const bq = getBQ();

  const experimentsQuery = `
    SELECT
      experiment_id,
      variants_json
    FROM \`${PROJECT}.${CTA_DATASET}.lp_experiments\`
    WHERE client_id = @clientId
      AND status = 'running'
      AND DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)
    ORDER BY created_at DESC
    LIMIT 20
  `;
  const [expRows] = await bq.query({
    query: experimentsQuery,
    location: 'US',
    params: { clientId },
  });

  if (expRows.length === 0) {
    return { active_test_count: 0, leading_variant: '', tests: [] };
  }

  const expIds = (expRows as Array<{ experiment_id: string }>).map((r) => r.experiment_id);

  const allocQuery = `
    SELECT
      a.experiment_id,
      a.variant_id,
      a.weight
    FROM \`${PROJECT}.${CTA_DATASET}.lp_split_test_allocations\` a
    INNER JOIN (
      SELECT experiment_id, MAX(iteration) AS max_iter
      FROM \`${PROJECT}.${CTA_DATASET}.lp_split_test_allocations\`
      WHERE experiment_id IN UNNEST(@expIds)
        AND DATE(allocated_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
      GROUP BY experiment_id
      LIMIT 100
    ) latest
      ON a.experiment_id = latest.experiment_id
      AND a.iteration = latest.max_iter
    WHERE DATE(a.allocated_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    ORDER BY a.experiment_id, a.weight DESC
    LIMIT 100
  `;
  const [allocRows] = await bq.query({
    query: allocQuery,
    location: 'US',
    params: { expIds },
  });

  const byExp = new Map<string, Array<{ variant_id: string; weight: number }>>();
  for (const r of allocRows as Array<{ experiment_id: string; variant_id: string; weight: number }>) {
    if (!byExp.has(r.experiment_id)) byExp.set(r.experiment_id, []);
    byExp.get(r.experiment_id)!.push({ variant_id: r.variant_id, weight: r.weight ?? 0 });
  }

  let overallLeader = '';
  let overallLeaderWeight = -1;
  const tests = (expRows as Array<{ experiment_id: string; variants_json: string | null }>).map((exp) => {
    const variants = byExp.get(exp.experiment_id) ?? [];
    const leader = variants[0];
    if (leader && leader.weight > overallLeaderWeight) {
      overallLeaderWeight = leader.weight;
      overallLeader = leader.variant_id;
    }
    const variantCount = variants.length > 0
      ? variants.length
      : (() => {
          try { return (JSON.parse(exp.variants_json ?? '[]') as unknown[]).length; } catch { return 0; }
        })();
    return {
      id: exp.experiment_id,
      variants: variantCount,
      leading_p_best: leader ? round2(leader.weight) : 0,
    };
  });

  return {
    active_test_count: tests.length,
    leading_variant: overallLeader,
    tests,
  };
}

// Q12 — weekly work
export async function getWeeklyWork(
  clientId: string,
): Promise<{
  action_count: number;
  categories: Record<string, number>;
  recent: Array<{ ts: string; action: string; agent: string }>;
}> {
  const bq = getBQ();
  // audit_findings has: ingested_at (partition), dimension (STRING), findings (JSON), recommendations (JSON)
  // Extract summary from findings JSON for action, dimension for category
  const query = `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', ingested_at) AS ts,
      JSON_VALUE(findings, '$.summary') AS action,
      'system' AS agent,
      dimension AS category
    FROM \`${PROJECT}.${DATASET}.audit_findings\`
    WHERE client_id = @clientId
      AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    ORDER BY ingested_at DESC
    LIMIT 30
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId },
  });

  const recent = (rows as Array<{ ts: string; action: string | null; agent: string; category: string | null }>).map((r) => ({
    ts: r.ts,
    action: r.action ?? 'audit completed',
    agent: r.agent,
  }));

  const categoriesQuery = `
    SELECT
      dimension AS category,
      COUNT(*) AS n
    FROM \`${PROJECT}.${DATASET}.audit_findings\`
    WHERE client_id = @clientId
      AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    GROUP BY dimension
    ORDER BY n DESC
    LIMIT 20
  `;
  const [catRows] = await bq.query({
    query: categoriesQuery,
    location: 'US',
    params: { clientId },
  });
  const categories: Record<string, number> = {};
  for (const r of catRows as Array<{ category: string; n: number }>) {
    categories[r.category ?? 'other'] = r.n;
  }
  const total = Object.values(categories).reduce((a, b) => a + b, 0);
  return { action_count: total, categories, recent };
}

// Q13 — tracking health — Phase 5.12 verify cron complete.
// Derives health from daily_metrics last 48h: spend present but zero attributed conversions = degraded.
export async function getTrackingHealth(
  clientId: string,
): Promise<{ tracking_status: 'healthy' | 'degraded' | 'broken'; last_verify_at: string; failing_dimensions: string[] }> {
  const bq = getBQ();
  const query = `
    SELECT
      MAX(FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', TIMESTAMP(metric_date))) AS last_verify_at,
      SUM(spend) AS spend,
      SUM(conversions) AS conversions,
      SUM(conversion_value) AS conversion_value,
      COUNT(DISTINCT platform) AS platform_count
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)
    LIMIT 1
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId },
  });
  const row = (rows as Array<{
    last_verify_at: string | null;
    spend: number | null;
    conversions: number | null;
    conversion_value: number | null;
    platform_count: number | null;
  }>)[0];

  if (!row || !row.last_verify_at) {
    return {
      tracking_status: 'broken',
      last_verify_at: new Date(0).toISOString(),
      failing_dimensions: ['no_data_48h'],
    };
  }

  const spend = row.spend ?? 0;
  const conversions = row.conversions ?? 0;
  const failing: string[] = [];

  if (spend > 0 && conversions === 0) failing.push('conversion_tracking');
  if (spend === 0) failing.push('spend_data');

  const status: 'healthy' | 'degraded' | 'broken' =
    failing.length === 0 ? 'healthy' :
    failing.includes('spend_data') ? 'broken' :
    'degraded';

  return {
    tracking_status: status,
    last_verify_at: row.last_verify_at,
    failing_dimensions: failing,
  };
}

export class PortalQuestionUnimplementedError extends Error {
  constructor(public fnName: string, public dependency: string) {
    super(`${fnName} not yet implemented — depends on: ${dependency}`);
    this.name = 'PortalQuestionUnimplementedError';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
