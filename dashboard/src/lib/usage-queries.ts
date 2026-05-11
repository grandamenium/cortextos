// cortextOS Dashboard - Usage query layer
// Pure read-only queries over the cost_entries table + cron-execution.log files.
// No new schemas, no on-disk writes. Reuses cost-parser pricing.

import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { CTX_ROOT, getAgentDir, getAllAgents } from '@/lib/config';
import { resolvePricingKey, MODEL_PRICING } from '@/lib/cost-parser';
import type { AgentRuntime } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RangeDays = 1 | 7 | 30 | 90 | 'all';

export interface UsageTotals {
  cost_usd: number;
  input_cost_usd: number;
  output_cost_usd: number;
  cache_cost_usd: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  message_count: number;
}

export interface AgentUsageSummary extends UsageTotals {
  agent: string;
  org: string;
  runtime: AgentRuntime;
  cron_mode: 'inject' | 'print' | null;
  cron_runs: number;
  last_active: string | null;
}

export interface DailyCostPoint {
  date: string;
  cost: number;
}

export interface DailyCostByModelPoint {
  date: string;
  [modelKey: string]: number | string;
}

export interface SessionRow {
  source_file: string;
  session_label: string;
  started_at: string;
  ended_at: string;
  message_count: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
}

export interface CronRunRow {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  duration_ms: number;
  error?: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  approximate: boolean;
}

export interface CronAggregateRow {
  cron: string;
  runs: number;
  total_tokens: number;
  cost_usd: number;
  last_fire: string;
  last_status: 'fired' | 'retried' | 'failed';
  approximate: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GRACE_MS = 30_000;

function sinceClause(days: RangeDays): string {
  if (days === 'all') return '';
  // SQLite's `-1 days` modifier is valid; this covers the 24h range as well.
  return ` AND timestamp >= datetime('now', '-${days} days')`;
}

interface CostBreakdown {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_cost_usd: number;
}

/**
 * Compute input/output/cache cost breakdown from per-model token totals.
 * Cache cost is the residual: total - input - output. This is faithful to how
 * the parser computed the original cost_usd (sum of all four components), so
 * the breakdown always reconciles back to the row's total.
 */
function breakdownFromRows(
  rows: Array<{ model: string; input_tokens: number; output_tokens: number; total_cost: number }>,
): CostBreakdown {
  let input_cost_usd = 0;
  let output_cost_usd = 0;
  let total = 0;
  for (const r of rows) {
    const pricing = MODEL_PRICING[resolvePricingKey(r.model)] ?? MODEL_PRICING.sonnet;
    input_cost_usd += (r.input_tokens / 1_000_000) * pricing.inputPerMillion;
    output_cost_usd += (r.output_tokens / 1_000_000) * pricing.outputPerMillion;
    total += r.total_cost;
  }
  // Round to 4 decimals so JSON stays compact and UI math doesn't drift
  input_cost_usd = Math.round(input_cost_usd * 10_000) / 10_000;
  output_cost_usd = Math.round(output_cost_usd * 10_000) / 10_000;
  const cache_cost_usd = Math.max(0, Math.round((total - input_cost_usd - output_cost_usd) * 10_000) / 10_000);
  return { input_cost_usd, output_cost_usd, cache_cost_usd };
}

function getBreakdownByAgent(days: RangeDays, agent?: string): Map<string, CostBreakdown> {
  try {
    const where = agent ? 'WHERE agent = ?' : 'WHERE 1=1';
    const params = agent ? [agent] : [];
    const rows = db
      .prepare(
        `SELECT agent, model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS total_cost
         FROM cost_entries
         ${where} ${sinceClause(days)}
         GROUP BY agent, model`,
      )
      .all(...params) as Array<{
        agent: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        total_cost: number;
      }>;

    const byAgent = new Map<string, Array<typeof rows[number]>>();
    for (const r of rows) {
      if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
      byAgent.get(r.agent)!.push(r);
    }
    const out = new Map<string, CostBreakdown>();
    for (const [a, rs] of byAgent.entries()) out.set(a, breakdownFromRows(rs));
    return out;
  } catch {
    return new Map();
  }
}

function getFleetBreakdown(days: RangeDays): CostBreakdown {
  try {
    const rows = db
      .prepare(
        `SELECT model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS total_cost
         FROM cost_entries
         WHERE 1=1 ${sinceClause(days)}
         GROUP BY model`,
      )
      .all() as Array<{
        model: string;
        input_tokens: number;
        output_tokens: number;
        total_cost: number;
      }>;
    return breakdownFromRows(rows);
  } catch {
    return { input_cost_usd: 0, output_cost_usd: 0, cache_cost_usd: 0 };
  }
}

function readAgentConfig(name: string, org: string): { runtime: AgentRuntime; cron_mode: 'inject' | 'print' | null } {
  const agentDir = getAgentDir(name, org);
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { runtime?: string; cron_mode?: string };
    const runtime: AgentRuntime =
      cfg.runtime === 'codex-app-server' || cfg.runtime === 'hermes'
        ? cfg.runtime
        : 'claude-code';
    const cron_mode =
      cfg.cron_mode === 'print' || cfg.cron_mode === 'inject' ? cfg.cron_mode : null;
    return { runtime, cron_mode };
  } catch {
    return { runtime: 'claude-code', cron_mode: null };
  }
}

function cronLogPath(agent: string): string {
  return path.join(CTX_ROOT, '.cortextOS', 'state', 'agents', agent, 'cron-execution.log');
}

interface RawCronEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt?: number;
  duration_ms: number;
  error?: string | null;
}

function readCronLog(agent: string): RawCronEntry[] {
  const filePath = cronLogPath(agent);
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    const entries: RawCronEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RawCronEntry;
        if (parsed.ts && parsed.cron && parsed.status) entries.push(parsed);
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fleet queries
// ---------------------------------------------------------------------------

export function getFleetUsageSummary(days: RangeDays = 30): {
  total_cost_usd: number;
  input_cost_usd: number;
  output_cost_usd: number;
  cache_cost_usd: number;
  total_tokens: number;
  agent_count: number;
  cron_runs: number;
} {
  try {
    const row = db
      .prepare(
        `SELECT
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COUNT(DISTINCT agent) as agent_count
        FROM cost_entries
        WHERE 1=1 ${sinceClause(days)}`,
      )
      .get() as { total_cost_usd: number; total_tokens: number; agent_count: number };

    // Cron runs: walk every agent's cron log and count entries within range
    let cronRuns = 0;
    const cutoffMs =
      days === 'all' ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
    for (const { name } of getAllAgents()) {
      const entries = readCronLog(name);
      for (const e of entries) {
        const t = Date.parse(e.ts);
        if (Number.isFinite(t) && t >= cutoffMs) cronRuns++;
      }
    }

    const breakdown = getFleetBreakdown(days);
    return { ...row, ...breakdown, cron_runs: cronRuns };
  } catch {
    return {
      total_cost_usd: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      cache_cost_usd: 0,
      total_tokens: 0,
      agent_count: 0,
      cron_runs: 0,
    };
  }
}

export function getFleetDailyCostByModel(days: RangeDays = 30): DailyCostByModelPoint[] {
  try {
    const rows = db
      .prepare(
        `SELECT DATE(timestamp) as date, model, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE 1=1 ${sinceClause(days)}
         GROUP BY DATE(timestamp), model
         ORDER BY date ASC`,
      )
      .all() as Array<{ date: string; model: string; cost: number }>;

    const dateMap = new Map<string, DailyCostByModelPoint>();
    for (const row of rows) {
      if (!dateMap.has(row.date)) dateMap.set(row.date, { date: row.date });
      const entry = dateMap.get(row.date)!;
      const key = resolvePricingKey(row.model);
      entry[key] = ((entry[key] as number) ?? 0) + row.cost;
    }
    return Array.from(dateMap.values());
  } catch {
    return [];
  }
}

export function getFleetAgentList(days: RangeDays = 30): AgentUsageSummary[] {
  try {
    const rows = db
      .prepare(
        `SELECT
          agent,
          org,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COUNT(*) as message_count,
          MAX(timestamp) as last_active
        FROM cost_entries
        WHERE 1=1 ${sinceClause(days)}
        GROUP BY agent, org
        ORDER BY cost_usd DESC`,
      )
      .all() as Array<{
        agent: string;
        org: string;
        cost_usd: number;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        message_count: number;
        last_active: string;
      }>;

    const cutoffMs =
      days === 'all' ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
    const breakdowns = getBreakdownByAgent(days);

    return rows.map((r) => {
      const { runtime, cron_mode } = readAgentConfig(r.agent, r.org);
      const entries = readCronLog(r.agent);
      const cronRuns = entries.filter((e) => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) && t >= cutoffMs;
      }).length;
      const b = breakdowns.get(r.agent) ?? {
        input_cost_usd: 0,
        output_cost_usd: 0,
        cache_cost_usd: 0,
      };
      return {
        agent: r.agent,
        org: r.org,
        runtime,
        cron_mode,
        cost_usd: r.cost_usd,
        input_cost_usd: b.input_cost_usd,
        output_cost_usd: b.output_cost_usd,
        cache_cost_usd: b.cache_cost_usd,
        total_tokens: r.total_tokens,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        message_count: r.message_count,
        cron_runs: cronRuns,
        last_active: r.last_active ?? null,
      };
    });
  } catch {
    return [];
  }
}

export function getAgentSparkline(agent: string, days: number = 14): number[] {
  try {
    const rows = db
      .prepare(
        `SELECT DATE(timestamp) as date, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE agent = ? AND timestamp >= datetime('now', ?)
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`,
      )
      .all(agent, `-${days} days`) as Array<{ date: string; cost: number }>;

    // Pad to exactly `days` slots (oldest → newest) so sparklines align
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const out: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const found = rows.find((r) => r.date === d);
      out.push(found?.cost ?? 0);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-agent queries
// ---------------------------------------------------------------------------

export function getAgentUsageSummary(
  agent: string,
  days: RangeDays = 30,
): AgentUsageSummary | null {
  try {
    const row = db
      .prepare(
        `SELECT
          agent,
          org,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COUNT(*) as message_count,
          MAX(timestamp) as last_active
        FROM cost_entries
        WHERE agent = ? ${sinceClause(days)}
        GROUP BY agent, org`,
      )
      .get(agent) as
        | {
            agent: string;
            org: string;
            cost_usd: number;
            total_tokens: number;
            input_tokens: number;
            output_tokens: number;
            message_count: number;
            last_active: string;
          }
        | undefined;

    // Still return a row with zeros if no cost entries — discover the agent's org
    if (!row) {
      const meta = getAllAgents().find((a) => a.name === agent);
      if (!meta) return null;
      const { runtime, cron_mode } = readAgentConfig(agent, meta.org);
      return {
        agent,
        org: meta.org,
        runtime,
        cron_mode,
        cost_usd: 0,
        input_cost_usd: 0,
        output_cost_usd: 0,
        cache_cost_usd: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        message_count: 0,
        cron_runs: 0,
        last_active: null,
      };
    }

    const { runtime, cron_mode } = readAgentConfig(row.agent, row.org);
    const cutoffMs =
      days === 'all' ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
    const cronRuns = readCronLog(agent).filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoffMs;
    }).length;
    const breakdown = getBreakdownByAgent(days, agent).get(agent) ?? {
      input_cost_usd: 0,
      output_cost_usd: 0,
      cache_cost_usd: 0,
    };

    return {
      agent: row.agent,
      org: row.org,
      runtime,
      cron_mode,
      cost_usd: row.cost_usd,
      input_cost_usd: breakdown.input_cost_usd,
      output_cost_usd: breakdown.output_cost_usd,
      cache_cost_usd: breakdown.cache_cost_usd,
      total_tokens: row.total_tokens,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      message_count: row.message_count,
      cron_runs: cronRuns,
      last_active: row.last_active ?? null,
    };
  } catch {
    return null;
  }
}

export function getAgentDailyCost(agent: string, days: RangeDays = 30): DailyCostPoint[] {
  try {
    return db
      .prepare(
        `SELECT DATE(timestamp) as date, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE agent = ? ${sinceClause(days)}
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`,
      )
      .all(agent) as DailyCostPoint[];
  } catch {
    return [];
  }
}

export function getAgentDailyCostByModel(
  agent: string,
  days: RangeDays = 30,
): DailyCostByModelPoint[] {
  try {
    const rows = db
      .prepare(
        `SELECT DATE(timestamp) as date, model, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE agent = ? ${sinceClause(days)}
         GROUP BY DATE(timestamp), model
         ORDER BY date ASC`,
      )
      .all(agent) as Array<{ date: string; model: string; cost: number }>;

    const dateMap = new Map<string, DailyCostByModelPoint>();
    for (const row of rows) {
      if (!dateMap.has(row.date)) dateMap.set(row.date, { date: row.date });
      const entry = dateMap.get(row.date)!;
      const key = resolvePricingKey(row.model);
      entry[key] = ((entry[key] as number) ?? 0) + row.cost;
    }
    return Array.from(dateMap.values());
  } catch {
    return [];
  }
}

export function getAgentSessions(
  agent: string,
  days: RangeDays = 30,
  limit: number = 50,
): SessionRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT
          source_file,
          MIN(timestamp) as started_at,
          MAX(timestamp) as ended_at,
          COUNT(*) as message_count,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as cost_usd,
          (
            SELECT model FROM cost_entries c2
            WHERE c2.agent = ? AND c2.source_file = c1.source_file
            ORDER BY c2.timestamp DESC LIMIT 1
          ) as model
        FROM cost_entries c1
        WHERE agent = ? AND source_file IS NOT NULL ${sinceClause(days)}
        GROUP BY source_file
        ORDER BY ended_at DESC
        LIMIT ?`,
      )
      .all(agent, agent, limit) as Array<{
        source_file: string;
        started_at: string;
        ended_at: string;
        message_count: number;
        total_tokens: number;
        cost_usd: number;
        model: string;
      }>;

    return rows.map((r) => ({
      source_file: r.source_file,
      session_label: sessionLabelFromPath(r.source_file),
      started_at: r.started_at,
      ended_at: r.ended_at,
      message_count: r.message_count,
      total_tokens: r.total_tokens,
      cost_usd: r.cost_usd,
      model: r.model ?? '',
    }));
  } catch {
    return [];
  }
}

function sessionLabelFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.jsonl$/, '');
}

// ---------------------------------------------------------------------------
// Cron attribution — time-window heuristic
// ---------------------------------------------------------------------------

interface CostRowMin {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

function fetchCostRowsInWindow(
  agent: string,
  windowStart: string,
  windowEnd: string,
): CostRowMin[] {
  try {
    return db
      .prepare(
        `SELECT timestamp, input_tokens, output_tokens, total_tokens, cost_usd
         FROM cost_entries
         WHERE agent = ?
           AND timestamp >= ?
           AND timestamp <= ?`,
      )
      .all(agent, windowStart, windowEnd) as CostRowMin[];
  } catch {
    return [];
  }
}

function attributeCronRuns(
  agent: string,
  entries: RawCronEntry[],
  approximate: boolean,
): CronRunRow[] {
  // Build windows: [ts, ts + duration_ms + GRACE_MS]
  // De-overlap: if two windows overlap, the earlier one wins (deterministic).
  const sorted = [...entries].sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );

  type Window = {
    start: number;
    end: number;
    entry: RawCronEntry;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };

  const windows: Window[] = sorted.map((e) => {
    const start = Date.parse(e.ts);
    const end = start + (e.duration_ms ?? 0) + GRACE_MS;
    return {
      start,
      end,
      entry: e,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
  });

  // For each window, fetch cost rows within. Then dedupe: a cost row can only
  // belong to the earliest window whose [start, end] contains it.
  const claimed = new Set<string>(); // key: timestamp + cost_usd
  for (const w of windows) {
    const startIso = new Date(w.start).toISOString();
    const endIso = new Date(w.end).toISOString();
    const rows = fetchCostRowsInWindow(agent, startIso, endIso);
    for (const r of rows) {
      const key = `${r.timestamp}|${r.cost_usd}|${r.total_tokens}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      w.cost_usd += r.cost_usd;
      w.input_tokens += r.input_tokens;
      w.output_tokens += r.output_tokens;
      w.total_tokens += r.total_tokens;
    }
  }

  return windows.map((w) => ({
    ts: w.entry.ts,
    cron: w.entry.cron,
    status: w.entry.status,
    duration_ms: w.entry.duration_ms ?? 0,
    error: w.entry.error ?? null,
    input_tokens: w.input_tokens,
    output_tokens: w.output_tokens,
    total_tokens: w.total_tokens,
    cost_usd: Math.round(w.cost_usd * 1_000_000) / 1_000_000,
    approximate,
  }));
}

export function getAgentCronRuns(
  agent: string,
  days: RangeDays = 30,
  limit: number = 200,
): CronRunRow[] {
  const meta = getAllAgents().find((a) => a.name === agent);
  if (!meta) return [];
  const { cron_mode } = readAgentConfig(agent, meta.org);
  const approximate = cron_mode !== 'print'; // print mode is exact; inject is approx; null default = approx

  const cutoffMs = days === 'all' ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
  const all = readCronLog(agent).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoffMs;
  });

  const attributed = attributeCronRuns(agent, all, approximate);
  return attributed
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

export function getAgentCronAggregates(
  agent: string,
  days: RangeDays = 30,
): CronAggregateRow[] {
  const runs = getAgentCronRuns(agent, days, 1000);
  const byName = new Map<string, CronAggregateRow>();
  for (const r of runs) {
    const existing = byName.get(r.cron);
    if (!existing) {
      byName.set(r.cron, {
        cron: r.cron,
        runs: 1,
        total_tokens: r.total_tokens,
        cost_usd: r.cost_usd,
        last_fire: r.ts,
        last_status: r.status,
        approximate: r.approximate,
      });
    } else {
      existing.runs += 1;
      existing.total_tokens += r.total_tokens;
      existing.cost_usd += r.cost_usd;
      // r is already in newest-first order; first encounter sets last_fire/status
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.cost_usd - a.cost_usd);
}
