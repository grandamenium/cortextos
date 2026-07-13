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

import { NextRequest } from 'next/server';
import { entriesToCsv, readExecutionLogPage } from '@/lib/data/cron-executions';

export const dynamic = 'force-dynamic';

type StatusFilter = 'all' | 'success' | 'failure';
const VALID_AGENT = /^[a-z0-9_-]+$/i;

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
