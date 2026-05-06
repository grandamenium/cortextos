/**
 * GET /api/workflows/health
 *
 * Returns fleet health data: per-cron health state (healthy/warning/failure/never-fired)
 * aggregated across all enabled agents.
 *
 * Data is computed server-side by reading crons.json + cron-execution.log directly
 * (same pattern as /api/workflows/crons — no daemon IPC required).
 *
 * Optional query params:
 *   ?agent=<name>  — filter to a single agent
 *
 * Response shape:
 *   {
 *     rows: CronHealthRow[],
 *     summary: {
 *       total, healthy, warning, failure, neverFired,
 *       agents: { [agentName]: AgentHealthSummary }
 *     }
 *   }
 */

import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { CTX_ROOT, getAllAgents } from '@/lib/config';
import { parseDurationMs } from '@/lib/cron-utils';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Mirrored types (avoid importing daemon-side Node modules)
// ---------------------------------------------------------------------------

interface CronDefinition {
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  created_at: string;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
  fire_at?: string;
  metadata?: Record<string, unknown>;
}

interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';
const WARNING_MULTIPLIER = 2;
const ONCE_GRACE_MS = 10 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

function readAgentCrons(agentName: string): CronDefinition[] {
  const filePath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'crons.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.crons)) return parsed.crons as CronDefinition[];
    return [];
  } catch {
    return [];
  }
}

function readExecutionLog(agentName: string): CronExecutionLogEntry[] {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return [];
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const entries: CronExecutionLogEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as CronExecutionLogEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Next-fire computation (mirrors /api/workflows/crons logic)
// ---------------------------------------------------------------------------

function computeNextFire(schedule: string, lastFiredAt: string | undefined, now: number): string {
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : now;
  const durationMs = parseDurationMs(schedule);
  if (!isNaN(durationMs)) {
    const next = referenceMs + durationMs;
    return new Date(next <= now ? now + durationMs : next).toISOString();
  }
  const nextMs = nextFireFromCronExpr(schedule, now);
  if (!isNaN(nextMs)) return new Date(nextMs).toISOString();
  return 'unknown';
}

function nextFireFromCronExpr(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  function expand(field: string, min: number, max: number): number[] {
    const result = new Set<number>();
    for (const part of field.split(',')) {
      if (part === '*') { for (let i = min; i <= max; i++) result.add(i); }
      else if (part.startsWith('*/')) {
        const step = parseInt(part.slice(2), 10);
        if (isNaN(step) || step <= 0) throw new Error('bad step');
        for (let i = min; i <= max; i += step) result.add(i);
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
        if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error('bad range');
        for (let i = lo; i <= hi; i++) result.add(i);
      } else {
        const n = parseInt(part, 10);
        if (isNaN(n)) throw new Error('bad value');
        result.add(n);
      }
    }
    return [...result].sort((a, b) => a - b);
  }

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expand(minuteStr, 0, 59);
    hours   = expand(hourStr, 0, 23);
    doms    = expand(domStr, 1, 31);
    months  = expand(monthStr, 1, 12);
    dows    = expand(dowStr, 0, 6);
  } catch { return NaN; }

  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  let candidate = startMs;
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const d = new Date(candidate);
    if (months.includes(d.getMonth() + 1) && doms.includes(d.getDate()) &&
        dows.includes(d.getDay()) && hours.includes(d.getHours()) &&
        minutes.includes(d.getMinutes())) return candidate;
    candidate += 60_000;
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Health computation (pure, mirrors src/utils/cron-health.ts)
// ---------------------------------------------------------------------------

function computeHealth(
  agent: string,
  org: string,
  cron: CronDefinition,
  lastFire: string | null,
  lastStatus: 'fired' | 'retried' | 'failed' | null,
  nextFire: string,
  executionsLast24h: CronExecutionLogEntry[],
  nowMs: number,
): CronHealthRow {
  const lastFireMs: number | null = lastFire ? new Date(lastFire).getTime() : null;
  const gapMs: number | null = lastFireMs !== null ? nowMs - lastFireMs : null;
  const expectedIntervalMs = Math.max(0, parseDurationMs(cron.schedule) || 0);

  const firesLast24h = executionsLast24h.length;
  const successCount = executionsLast24h.filter(e => e.status === 'fired').length;
  const successRate24h = firesLast24h > 0 ? successCount / firesLast24h : 1;

  function make(state: CronHealthState, reason: string): CronHealthRow {
    return { agent, org, cronName: cron.name, state, reason, lastFire: lastFireMs,
             expectedIntervalMs, gapMs, successRate24h, firesLast24h, nextFire };
  }

  // One-shot cron not yet fired but still in grace window
  if (lastFireMs === null && cron.fire_at) {
    const fireAtMs = new Date(cron.fire_at).getTime();
    if (!isNaN(fireAtMs) && nowMs < fireAtMs + ONCE_GRACE_MS) {
      return make('healthy', `one-shot scheduled in the future (fire_at: ${cron.fire_at})`);
    }
  }

  if (lastFireMs === null) {
    return make('never-fired', 'cron has never fired — no execution history');
  }

  if (lastStatus === 'failed') {
    return make('failure', `most recent execution failed`);
  }

  if (expectedIntervalMs > 0 && gapMs !== null && gapMs > WARNING_MULTIPLIER * expectedIntervalMs) {
    const expectedLabel = formatMs(expectedIntervalMs);
    const gapLabel = formatMs(gapMs);
    return make('warning',
      `last fire ${gapLabel} ago, expected within ${expectedLabel} (2x threshold exceeded)`);
  }

  const gapLabel = gapMs !== null ? `${formatMs(gapMs)} ago` : 'never';
  return make('healthy', `last fired ${gapLabel}`);
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentFilter = searchParams.get('agent') ?? undefined;

  try {
    const allAgents = getAllAgents();
    const agents = agentFilter
      ? allAgents.filter(a => a.name === agentFilter)
      : allAgents;

    const nowMs = Date.now();
    const cutoff24h = nowMs - MS_24H;
    const healthRows: CronHealthRow[] = [];

    for (const agent of agents) {
      const crons = readAgentCrons(agent.name);
      if (crons.length === 0) continue;

      // Read the full execution log once per agent
      const allEntries = readExecutionLog(agent.name);

      for (const cron of crons) {
        // Last fire + status for this cron (most recent log entry)
        let lastFire: string | null = null;
        let lastStatus: 'fired' | 'retried' | 'failed' | null = null;
        for (let i = allEntries.length - 1; i >= 0; i--) {
          if (allEntries[i].cron === cron.name) {
            lastFire = allEntries[i].ts;
            lastStatus = allEntries[i].status;
            break;
          }
        }

        // 24h entries for this cron
        const last24h = allEntries.filter(
          e => e.cron === cron.name && new Date(e.ts).getTime() >= cutoff24h
        );

        const nextFire = computeNextFire(cron.schedule, cron.last_fired_at, nowMs);

        healthRows.push(computeHealth(
          agent.name,
          agent.org,
          cron,
          lastFire,
          lastStatus,
          nextFire,
          last24h,
          nowMs,
        ));
      }
    }

    // Build summary
    const summary: FleetHealthResponse['summary'] = {
      total: healthRows.length,
      healthy: 0,
      warning: 0,
      failure: 0,
      neverFired: 0,
      agents: {},
    };

    for (const row of healthRows) {
      switch (row.state) {
        case 'healthy':    summary.healthy++;    break;
        case 'warning':    summary.warning++;    break;
        case 'failure':    summary.failure++;    break;
        case 'never-fired': summary.neverFired++; break;
      }

      if (!summary.agents[row.agent]) {
        summary.agents[row.agent] = {
          agent: row.agent,
          org: row.org,
          total: 0,
          healthy: 0,
          warning: 0,
          failure: 0,
          neverFired: 0,
        };
      }
      const as = summary.agents[row.agent];
      as.total++;
      switch (row.state) {
        case 'healthy':    as.healthy++;    break;
        case 'warning':    as.warning++;    break;
        case 'failure':    as.failure++;    break;
        case 'never-fired': as.neverFired++; break;
      }
    }

    const result: FleetHealthResponse = { rows: healthRows, summary };
    return Response.json(result);
  } catch (err) {
    console.error('[api/workflows/health] GET error:', err);
    return Response.json({ error: 'Failed to compute fleet health' }, { status: 500 });
  }
}
