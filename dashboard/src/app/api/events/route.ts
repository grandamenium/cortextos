import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events - Query historical events from Postgres.
 *
 * Query params:
 *   limit  - max rows (default 50, max 500)
 *   offset - pagination offset (default 0)
 *   type   - filter by event type
 *   agent  - filter by agent name
 *   org    - filter by org
 *   from   - ISO date lower bound (inclusive)
 *   to     - ISO date upper bound (inclusive)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1),
    500
  );
  const offset = Math.max(
    parseInt(searchParams.get('offset') ?? '0', 10) || 0,
    0
  );
  const type = searchParams.get('type');
  const agent = searchParams.get('agent');
  const org = searchParams.get('org');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
      FROM events
      WHERE TRUE
      ${type ? sql`AND type = ${type}` : sql``}
      ${agent ? sql`AND agent = ${agent}` : sql``}
      ${org ? sql`AND org = ${org}` : sql``}
      ${from ? sql`AND timestamp >= ${from}` : sql``}
      ${to ? sql`AND timestamp <= ${to}` : sql``}
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const events = rows.map((row) => ({
      ...row,
      data: row.data ? JSON.parse(row.data as string) : null,
    }));

    return Response.json(events);
  } catch (err) {
    console.error('[api/events] Query error:', err);
    return Response.json({ error: 'Failed to query events' }, { status: 500 });
  }
}
