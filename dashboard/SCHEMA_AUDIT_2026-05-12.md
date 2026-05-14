# Dashboard BQ Schema Audit — 2026-05-12

Auditor: sherlock
Dispatch: mozart (msg 1778624524421-mozart-d45qd)
Tables checked: `daily_metrics`, `clients`, `hitl_recommendations`, `recommendations`, `audit_findings`

## Partition Configuration

| Table | Partition Column | Type | requirePartitionFilter |
|-------|-----------------|------|----------------------|
| daily_metrics | metric_date | DAY | No |
| hitl_recommendations | created_at | DAY | **Yes** |
| recommendations | (none) | — | No |
| audit_findings | ingested_at | DAY | **Yes** |
| clients | (none) | — | No |

---

## CRITICAL — Will break at runtime

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| C1 | lib/portal-questions.ts | 53 | Column `cost_micros` does not exist in daily_metrics | Use `spend` (NUMERIC, already in dollars) |
| C2 | lib/portal-questions.ts | 56 | WHERE `date BETWEEN` — column is `metric_date`, not `date` | Replace `date` → `metric_date` |
| C3 | lib/portal-questions.ts | 57 | `_PARTITIONTIME >= TIMESTAMP(@start)` — partition column is `metric_date`, not `_PARTITIONTIME` | Remove this line; `metric_date BETWEEN` already prunes |
| C4 | lib/portal-questions.ts | 95 | Column `revenue` does not exist in daily_metrics | Use `conversion_value` (NUMERIC) |
| C5 | lib/portal-questions.ts | 96 | Column `cost_micros` does not exist | Use `spend` |
| C6 | lib/portal-questions.ts | 99-100 | `date` → `metric_date`, `_PARTITIONTIME` → remove | Same as C2/C3 |
| C7 | lib/portal-questions.ts | 134 | Column `cost_micros` does not exist | Use `spend` |
| C8 | lib/portal-questions.ts | 133,138-139 | `date` → `metric_date`, `_PARTITIONTIME` → remove | Same as C2/C3 |
| C9 | lib/portal-questions.ts | 179 | Column `cpa_target` does not exist in clients | Use `cpl_target` (NUMERIC) |
| C10 | lib/portal-questions.ts | 208 | Column `qualified_conversions` does not exist in daily_metrics | Remove or stub to 0 — no qualified-conv column exists |
| C11 | lib/portal-questions.ts | 206,211-212 | `date` → `metric_date`, `_PARTITIONTIME` → remove | Same as C2/C3 |
| C12 | lib/portal-questions.ts | 256 | Column `campaign_name` does not exist in daily_metrics | Use `campaign_id` or join on campaigns dim (if exists) |
| C13 | lib/portal-questions.ts | 257 | Column `revenue` does not exist | Use `conversion_value` |
| C14 | lib/portal-questions.ts | 259-261 | `date` → `metric_date`, `_PARTITIONTIME` → remove | Same as C2/C3 |
| C15 | lib/portal-questions.ts | 321 | Column `primary_goal_type` does not exist in clients | Use `primary_funnel_type` or hardcode 'spend' |
| C16 | lib/portal-questions.ts | 369 | Column `action` does not exist in audit_findings | Schema has `findings` (JSON) and `recommendations` (JSON) |
| C17 | lib/portal-questions.ts | 370 | Column `agent` does not exist in audit_findings | No agent column — extract from `findings` JSON or add column |
| C18 | lib/portal-questions.ts | 371 | Column `ts` does not exist in audit_findings | Use `ingested_at` (TIMESTAMP) |
| C19 | lib/portal-questions.ts | 375 | `_PARTITIONTIME` on audit_findings | Partition column is `ingested_at` |
| C20 | lib/portal-questions.ts | 387 | Column `category` does not exist in audit_findings | Use `dimension` (STRING) |
| C21 | lib/portal-questions.ts | 391 | `ts` and `_PARTITIONTIME` on audit_findings | Use `ingested_at` |
| C22 | app/api/recommendations/route.ts | 93-98 | UPDATE DML on BQ — fails in sandbox mode | Replace with status-change pattern: INSERT new row or use streaming API |
| C23 | app/api/recommendations/route.ts | 100-105 | UPDATE DML (skip action) | Same as C22 |
| C24 | app/api/recommendations/route.ts | 114-121 | UPDATE DML (snooze action) | Same as C22 |

**Total CRITICAL: 24**

---

## WARNING — Won't break but violates fleet query rules

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| W1 | lib/data/warehouse.ts | 37-64 | getHeadlineMetrics() — no LIMIT clause | Add `LIMIT 1` (CTE aggregates to single row) |
| W2 | lib/data/warehouse.ts | 232-246 | getDataFreshness() — no date range filter | Scans all partitions; add `AND dm.metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)` |
| W3 | lib/questions/bq.ts | 104-112 | spendFacts() — no LIMIT | Add `LIMIT 100` |
| W4 | lib/questions/bq.ts | 132-144 | revenueFacts() — no LIMIT | Add `LIMIT 100` |
| W5 | lib/questions/bq.ts | 210-231 | trendFacts() — no LIMIT | Add `LIMIT 10` (UNION of 2 single-row CTEs) |
| W6 | lib/questions/bq.ts | 308-320 | costPerLeadFacts() — no LIMIT | Add `LIMIT 100` |
| W7 | lib/portal-questions.ts | 367-377 | getWeeklyWork() — returns raw rows, not aggregate | Acceptable for activity log; add `entity_type` filter or redesign |

**Total WARNING: 7**

---

## Files with NO issues (clean)

| File | Queries | Notes |
|------|---------|-------|
| lib/bq-clients.ts | 4 | All columns valid, partition-filtered, LIMIT present |
| app/api/optimization/route.ts | 1 | hitl_recommendations — columns valid, partition-filtered, LIMIT 100 |
| app/api/recommendations/route.ts (GET) | 1 | recommendations table — columns valid, LIMIT present |

---

## Summary by file

| File | CRITICAL | WARNING | Notes |
|------|----------|---------|-------|
| lib/portal-questions.ts | 21 | 1 | Written against Google Ads API schema (cost_micros/revenue), not BQ schema |
| app/api/recommendations/route.ts | 3 | 0 | DML UPDATE incompatible with BQ (no sandbox DML) |
| lib/data/warehouse.ts | 0 | 2 | Missing LIMIT + full partition scan |
| lib/questions/bq.ts | 0 | 4 | Missing LIMIT clauses |
| lib/bq-clients.ts | 0 | 0 | Clean |
| app/api/optimization/route.ts | 0 | 0 | Clean |

---

## Root Cause

`portal-questions.ts` was written against a Google Ads API-style schema (cost_micros in microcents, revenue, campaign_name, _PARTITIONTIME) rather than the actual BQ `daily_metrics` schema (spend in dollars, conversion_value, campaign_id, metric_date partition). Every query in that file needs column remapping.

`recommendations/route.ts` PATCH handler uses BQ UPDATE statements which require DML privileges — not available in BQ sandbox. Needs architectural change to append-only pattern or external state store.

---

## Non-Obvious Rewrites

### W2 — warehouse.ts getDataFreshness() full partition scan

Current query has no date range, so `MAX(dm.metric_date)` scans every partition. Fix: add a generous lower bound that still catches stale clients without scanning history:

```sql
-- Add to WHERE clause (line ~241):
AND dm.metric_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
```

90 days catches any client that's been dark up to 3 months. Anything staler than that is dead, not "stale." Cuts bytes-scanned ~90% for a table that grows daily.

### C22-C24 — recommendations/route.ts DML refactor

BQ sandbox forbids UPDATE/DELETE. Two options:

**Option A — Append-only status log (recommended).** Create `recommendation_status_log` table:

```sql
CREATE TABLE analytics.recommendation_status_log (
  rec_id STRING NOT NULL,
  new_status STRING NOT NULL,
  reason STRING,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
) PARTITION BY DATE(changed_at);
```

PATCH handler INSERTs a new row. Read queries JOIN and pick latest status:

```sql
SELECT r.*, COALESCE(s.new_status, r.status) AS effective_status
FROM recommendations r
LEFT JOIN (
  SELECT rec_id, new_status, reason,
         ROW_NUMBER() OVER (PARTITION BY rec_id ORDER BY changed_at DESC) AS rn
  FROM recommendation_status_log
) s ON r.rec_id = s.rec_id AND s.rn = 1
```

**Option B — Move status to SQLite/Postgres.** Keep BQ as read-only analytics, store mutable approval state in the dashboard's existing SQLite (portal_answers already lives there). Simpler writes, but splits the recommendation data across two stores.

Option A keeps everything in BQ and is append-only (matches fleet convention). Option B is simpler code but adds a cross-store join at read time.

### C16-C21 — portal-questions.ts getWeeklyWork() against audit_findings

This query assumes audit_findings has `action`, `agent`, `ts`, `category` columns — none exist. The table actually stores structured audit results per dimension (score, findings JSON, recommendations JSON). Two paths:

**If the intent is "show recent agent activity":** query the `events` table instead (which likely has action/agent/timestamp columns). Check `bq show --schema click-to-acquire:analytics.events` for the right columns.

**If the intent is "show audit findings as work items":** rewrite to extract from the JSON columns:

```sql
SELECT
  JSON_VALUE(findings, '$.summary') AS action,
  'system' AS agent,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', ingested_at) AS ts
FROM `click-to-acquire.analytics.audit_findings`
WHERE client_id = @clientId
  AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
ORDER BY ingested_at DESC
LIMIT 30
```

Coder should check the `events` table schema first — that's likely the right source for "weekly work done."
