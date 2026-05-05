/**
 * GET /api/workflows/crons/[agent]/executions
 *
 * Returns recent cron execution log entries for a specific agent.
 * Used by the Workflows dashboard page detail panel (read-only, Subtask 4.1).
 *
 * Query params:
 *   ?cronName=<name>      — filter to a specific cron (optional)
 *   ?limit=<n>            — max entries to return (default: 100, max: 500)
 *   ?offset=<n>           — entries to skip from the most-recent end (default: 0)
 *   ?status=success|failure|all — filter by outcome (default: all)
 *   ?format=csv|json      — download format; sets Content-Disposition header
 *                           (default: regular JSON array, no download)
 */

import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { CTX_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'success' | 'failure';

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

export interface ExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// File reader with pagination + filter
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';
const VALID_AGENT = /^[a-z0-9_-]+$/i;

export function readExecutionLogPage(
  agentName: string,
  cronName: string | undefined,
  limit: number,
  offset: number,
  statusFilter: StatusFilter,
): ExecutionLogPage {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return { entries: [], total: 0, hasMore: false };

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return { entries: [], total: 0, hasMore: false };
  }

  const allEntries: CronExecutionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      allEntries.push(JSON.parse(trimmed) as CronExecutionLogEntry);
    } catch {
      // skip malformed line
    }
  }

  // Filter by cron name
  let filtered = cronName
    ? allEntries.filter(e => e.cron === cronName)
    : allEntries;

  // Filter by status
  if (statusFilter === 'success') {
    filtered = filtered.filter(e => e.status === 'fired');
  } else if (statusFilter === 'failure') {
    filtered = filtered.filter(e => e.status === 'failed');
  }

  const total = filtered.length;

  // Pagination: offset=0 → most recent `limit` entries
  if (limit <= 0) {
    const safeOffset = Math.min(offset, total);
    return { entries: filtered.slice(0, total - safeOffset), total, hasMore: false };
  }

  const safeOffset = Math.max(0, Math.min(offset, total));
  const end = total - safeOffset;
  const start = Math.max(0, end - limit);
  const entries = filtered.slice(start, end);
  const hasMore = start > 0;

  return { entries, total, hasMore };
}

// ---------------------------------------------------------------------------
// CSV serialiser
// ---------------------------------------------------------------------------

export function entriesToCsv(entries: CronExecutionLogEntry[]): string {
  const header = 'timestamp,cron,status,attempt,duration_ms,error';
  const rows = entries.map(e => {
    const ts = e.ts;
    const cron = csvEscape(e.cron);
    const status = e.status;
    const attempt = e.attempt;
    const duration = e.duration_ms;
    const error = csvEscape(e.error ?? '');
    return `${ts},${cron},${status},${attempt},${duration},${error}`;
  });
  return [header, ...rows].join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;
  const decoded = decodeURIComponent(agent);

  if (!VALID_AGENT.test(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const cronName = searchParams.get('cronName') ?? undefined;
  const limitParam = parseInt(searchParams.get('limit') ?? '100', 10);
  const limit = isNaN(limitParam) || limitParam <= 0 ? 100 : Math.min(limitParam, 500);
  const offsetParam = parseInt(searchParams.get('offset') ?? '0', 10);
  const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
  const rawStatus = searchParams.get('status') ?? 'all';
  const statusFilter: StatusFilter =
    rawStatus === 'success' || rawStatus === 'failure' ? rawStatus : 'all';
  const format = searchParams.get('format') ?? 'json';

  try {
    const page = readExecutionLogPage(decoded, cronName, limit, offset, statusFilter);

    if (format === 'csv') {
      const csv = entriesToCsv(page.entries);
      const filename = cronName
        ? `executions-${decoded}-${cronName}.csv`
        : `executions-${decoded}.csv`;
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    if (format === 'json-download') {
      const json = JSON.stringify(page.entries, null, 2);
      const filename = cronName
        ? `executions-${decoded}-${cronName}.json`
        : `executions-${decoded}.json`;
      return new Response(json, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Default: paginated JSON response with metadata
    return Response.json(page);
  } catch (err) {
    console.error(`[api/workflows/crons/${decoded}/executions] GET error:`, err);
    return Response.json({ error: 'Failed to read execution log' }, { status: 500 });
  }
}
