/**
 * GET /api/workflows/crons
 *
 * Returns a flat array of CronSummaryRow objects — one per cron across all
 * enabled agents.  Used by the Workflows dashboard page (read-only, Subtask 4.1).
 *
 * Data is read directly from disk (crons.json + cron-execution.log) — no daemon
 * IPC required.  This matches the pattern used by /api/agents/[name]/crons which
 * also reads config files directly from the server-side Next.js process.
 *
 * Optional query params:
 *   ?agent=<name>   — filter to a single agent
 *   ?search=<text>  — filter by cron name (case-insensitive substring)
 */

import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { CTX_ROOT, getAllAgents } from '@/lib/config';
import { parseDurationMs } from '@/lib/cron-utils';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types — mirror CronDefinition and CronExecutionLogEntry from src/types
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

export interface CronSummaryRow {
  agent: string;
  org: string;
  cron: CronDefinition;
  lastFire: string | null;
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  nextFire: string;
}

// ---------------------------------------------------------------------------
// File readers (server-side only)
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';

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

function readLastExecution(
  agentName: string,
  cronName: string,
): CronExecutionLogEntry | null {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return null;
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    // Walk backwards to find last entry for this cron
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as CronExecutionLogEntry;
        if (entry.cron === cronName) return entry;
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentFilter = searchParams.get('agent') ?? undefined;
  const searchFilter = searchParams.get('search')?.toLowerCase() ?? undefined;

  try {
    const allAgents = getAllAgents();
    const agents = agentFilter
      ? allAgents.filter(a => a.name === agentFilter)
      : allAgents;

    const now = Date.now();
    const rows: CronSummaryRow[] = [];

    for (const agent of agents) {
      const crons = readAgentCrons(agent.name);
      for (const cron of crons) {
        if (searchFilter && !cron.name.toLowerCase().includes(searchFilter)) continue;

        const lastEntry = readLastExecution(agent.name, cron.name);

        rows.push({
          agent: agent.name,
          org: agent.org,
          cron,
          lastFire: lastEntry?.ts ?? null,
          lastStatus: lastEntry?.status ?? null,
          nextFire: computeNextFire(cron.schedule, cron.last_fired_at, now),
        });
      }
    }

    return Response.json(rows);
  } catch (err) {
    console.error('[api/workflows/crons] GET error:', err);
    return Response.json({ error: 'Failed to list crons' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// nextFire computation — pure helper, no external deps
// ---------------------------------------------------------------------------

function computeNextFire(
  schedule: string,
  lastFiredAt: string | undefined,
  now: number,
): string {
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : now;

  const durationMs = parseDurationMs(schedule);
  if (!isNaN(durationMs)) {
    const next = referenceMs + durationMs;
    return new Date(next <= now ? now + durationMs : next).toISOString();
  }

  // Try as a 5-field cron expression
  const nextMs = nextFireFromCronExpr(schedule, now);
  if (!isNaN(nextMs)) {
    return new Date(nextMs).toISOString();
  }

  return 'unknown';
}

/**
 * Minimal 5-field cron expression evaluator (duplicate-free: references the
 * same algorithm as src/daemon/cron-scheduler.ts but runs in the Next.js
 * server process which cannot import daemon-side Node.js modules).
 *
 * Fields: minute hour dom month dow
 */
function nextFireFromCronExpr(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  function expand(field: string, min: number, max: number): number[] {
    const result = new Set<number>();
    for (const part of field.split(',')) {
      if (part === '*') {
        for (let i = min; i <= max; i++) result.add(i);
      } else if (part.startsWith('*/')) {
        const step = parseInt(part.slice(2), 10);
        if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);
        for (let i = min; i <= max; i += step) result.add(i);
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
        if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid range: ${part}`);
        for (let i = lo; i <= hi; i++) result.add(i);
      } else {
        const n = parseInt(part, 10);
        if (isNaN(n)) throw new Error(`Invalid value: ${part}`);
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
  } catch {
    return NaN;
  }

  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const MAX_MINUTES = 366 * 24 * 60;
  let candidate = startMs;

  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(candidate);
    if (
      months.includes(d.getMonth() + 1) &&
      doms.includes(d.getDate()) &&
      dows.includes(d.getDay()) &&
      hours.includes(d.getHours()) &&
      minutes.includes(d.getMinutes())
    ) {
      return candidate;
    }
    candidate += 60_000;
  }

  return NaN;
}

// ---------------------------------------------------------------------------
// POST /api/workflows/crons — create a new cron via IPC add-cron
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { agent, definition } = (body ?? {}) as {
    agent?: unknown;
    definition?: unknown;
  };

  if (!agent || typeof agent !== 'string') {
    return Response.json({ error: 'agent is required', field: 'agent' }, { status: 400 });
  }
  if (!definition || typeof definition !== 'object') {
    return Response.json({ error: 'definition is required', field: 'definition' }, { status: 400 });
  }

  const ipc = new IPCClient();
  try {
    const resp = await ipc.send({
      type: 'add-cron',
      agent,
      data: { definition: definition as Record<string, unknown> },
      source: 'dashboard/api',
    } as Parameters<typeof ipc.send>[0]);

    if (resp.success) {
      return Response.json({ ok: true }, { status: 201 });
    }

    // Detect duplicate name → 409
    const errMsg = resp.error ?? '';
    if (errMsg.includes('already exists')) {
      return Response.json({ error: errMsg, field: 'name' }, { status: 409 });
    }

    // Otherwise 400 with structured error from MutationResult
    const detail = (resp.data ?? {}) as Record<string, unknown>;
    return Response.json(
      { error: errMsg, field: detail.field ?? undefined },
      { status: 400 },
    );
  } catch (err) {
    console.error('[api/workflows/crons] POST error:', err);
    return Response.json({ error: 'Failed to create cron (IPC error)' }, { status: 500 });
  }
}
