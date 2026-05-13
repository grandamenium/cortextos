/**
 * BQ read helpers for the clients admin routes (PHASES Task 2.5).
 *
 * Aggregate-only queries per Rob rule: never SELECT *, always partition-filtered,
 * GROUP BY where applicable, LIMIT ≤ 100.
 *
 * TODO: requires runtime credentials:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON
 *   GCLOUD_PROJECT                 — GCP project ID (click-to-acquire)
 */

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'click-to-acquire';
const DATASET = 'analytics';

function getBQ(): BigQuery {
  return new BigQuery({ projectId: PROJECT });
}

export interface ClientRow {
  client_id: string;
  name: string;
  vertical: string;
  status: string;
  has_existing_accounts: boolean;
  gdrive_folder_id: string | null;
  ghl_location_id: string | null;
  onboarded_at: string | null;
  primary_funnel_type: string | null;
  lifecycle_stage: string | null;
  cta_platform_managed: boolean;
  last_activity: string | null;
}

export interface ClientListRow {
  client_id: string;
  name: string;
  vertical: string;
  status: string;
  last_activity: string | null;
}

export interface PerformanceSummary {
  date: string;
  impressions: number;
  clicks: number;
  conversions: number;
  cost: number;
}

/**
 * List all clients — columns: client_id, name, vertical, status, last_activity.
 * Aggregate-only: last_activity derived from MAX(updated_at).
 */
export async function listClients(): Promise<ClientListRow[]> {
  const bq = getBQ();
  // analytics.clients is a small dim table (no partitioning, no updated_at).
  // Use display_name + ingested_at as the activity proxy.
  const query = `
    SELECT
      client_id,
      display_name AS name,
      vertical,
      status,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(ingested_at)) AS last_activity
    FROM \`${PROJECT}.${DATASET}.clients\`
    GROUP BY client_id, display_name, vertical, status
    ORDER BY last_activity DESC
    LIMIT 100
  `;
  const [rows] = await bq.query({ query, location: 'US' });
  return rows as ClientListRow[];
}

/**
 * Get a single client's full row including all Phase 1.1 columns.
 */
export async function getClient(clientId: string): Promise<ClientRow | null> {
  const bq = getBQ();
  const query = `
    SELECT
      client_id,
      display_name AS name,
      vertical,
      status,
      has_existing_accounts,
      gdrive_folder_id,
      ghl_location_id,
      onboarded_at,
      primary_funnel_type,
      lifecycle_stage,
      cta_platform_managed,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(ingested_at)) AS last_activity
    FROM \`${PROJECT}.${DATASET}.clients\`
    WHERE client_id = @clientId
    GROUP BY
      client_id, display_name, vertical, status, has_existing_accounts,
      gdrive_folder_id, ghl_location_id, onboarded_at, primary_funnel_type,
      lifecycle_stage, cta_platform_managed
    LIMIT 1
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId },
  });
  return (rows[0] as ClientRow) ?? null;
}

/**
 * Get last-30-days performance aggregates for a client.
 * Reads from daily_metrics — partition-filtered by date, aggregate only.
 */
export async function getClientPerformance(clientId: string): Promise<PerformanceSummary[]> {
  const bq = getBQ();
  const query = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', metric_date) AS date,
      SUM(impressions) AS impressions,
      SUM(clicks) AS clicks,
      SUM(conversions) AS conversions,
      ROUND(SUM(spend), 2) AS cost
    FROM \`${PROJECT}.${DATASET}.daily_metrics\`
    WHERE client_id = @clientId
      AND metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    GROUP BY metric_date
    ORDER BY metric_date DESC
    LIMIT 31
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId },
  });
  return rows as PerformanceSummary[];
}

/**
 * Get pending HITL recommendations for a client.
 */
export async function getClientHitlQueue(clientId: string): Promise<Array<{ id: string; title: string; created_at: string; category: string }>> {
  const bq = getBQ();
  const query = `
    SELECT
      recommendation_id AS id,
      recommended_action AS title,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
      gate_type AS category
    FROM \`${PROJECT}.${DATASET}.hitl_recommendations\`
    WHERE client_id = @clientId
      AND status = 'pending'
      AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
    ORDER BY created_at DESC
    LIMIT 50
  `;
  const [rows] = await bq.query({
    query,
    location: 'US',
    params: { clientId },
  });
  return rows as Array<{ id: string; title: string; created_at: string; category: string }>;
}
