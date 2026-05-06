/**
 * GET /api/workflows/crons/[agent]/[name]/executions
 *
 * Returns paginated cron execution log entries for a specific agent + cron name.
 * Supports export downloads (CSV and JSON).
 *
 * Query params:
 *   ?limit=<n>              — max entries per page (default: 100, max: 500)
 *   ?offset=<n>             — entries to skip from most-recent end (default: 0)
 *   ?status=success|failure|all — filter by outcome (default: all)
 *   ?format=csv             — download as CSV with Content-Disposition header
 *   ?format=json-download   — download as JSON with Content-Disposition header
 *   (no format param)       — returns { entries, total, hasMore } JSON
 *
 * Delegates to the shared readExecutionLogPage + entriesToCsv helpers from the
 * agent-level executions route to avoid code duplication.
 */

import { NextRequest } from 'next/server';
import {
  readExecutionLogPage,
  entriesToCsv,
} from '@/app/api/workflows/crons/[agent]/executions/route';

export const dynamic = 'force-dynamic';

const VALID_IDENT = /^[a-zA-Z0-9_-]+$/;

type RouteParams = Promise<{ agent: string; name: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
) {
  const { agent, name } = await params;
  const decodedAgent = decodeURIComponent(agent);
  const decodedName = decodeURIComponent(name);

  if (!VALID_IDENT.test(decodedAgent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!VALID_IDENT.test(decodedName)) {
    return Response.json({ error: 'Invalid cron name' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = parseInt(searchParams.get('limit') ?? '100', 10);
  const limit = isNaN(limitParam) || limitParam <= 0 ? 100 : Math.min(limitParam, 500);
  const offsetParam = parseInt(searchParams.get('offset') ?? '0', 10);
  const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
  const rawStatus = searchParams.get('status') ?? 'all';
  const statusFilter = rawStatus === 'success' || rawStatus === 'failure' ? rawStatus : ('all' as const);
  const format = searchParams.get('format') ?? '';

  try {
    const page = readExecutionLogPage(decodedAgent, decodedName, limit, offset, statusFilter);

    if (format === 'csv') {
      const csv = entriesToCsv(page.entries);
      const filename = `executions-${decodedAgent}-${decodedName}.csv`;
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    if (format === 'json-download') {
      const json = JSON.stringify(page.entries, null, 2);
      const filename = `executions-${decodedAgent}-${decodedName}.json`;
      return new Response(json, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    return Response.json(page);
  } catch (err) {
    console.error(
      `[api/workflows/crons/${decodedAgent}/${decodedName}/executions] GET error:`,
      err,
    );
    return Response.json({ error: 'Failed to read execution log' }, { status: 500 });
  }
}
