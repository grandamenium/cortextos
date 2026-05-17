import { NextRequest } from 'next/server';
import {
  getPendingApprovals,
  getResolvedApprovals,
} from '@/lib/data/approvals';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/approvals - List approvals with optional filters
//
// Query params:
//   status   - "pending" (default) | "resolved" | "all"
//   org      - filter by org
//   agent    - filter by agent (resolved only)
//   category - filter by category (resolved only)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  void syncAll().catch(() => {});

  const status = searchParams.get('status') || 'pending';
  const org = searchParams.get('org') || undefined;
  const agent = searchParams.get('agent') || undefined;
  const category = searchParams.get('category') || undefined;

  try {
    let approvals;

    if (status === 'pending') {
      approvals = await getPendingApprovals(org);
    } else if (status === 'resolved') {
      approvals = await getResolvedApprovals(org, { agent, category });
    } else if (status === 'all') {
      const pending = await getPendingApprovals(org);
      const resolved = await getResolvedApprovals(org, { agent, category });
      approvals = [...pending, ...resolved];
    } else {
      return Response.json(
        { error: 'Invalid status. Must be one of: pending, resolved, all' },
        { status: 400 },
      );
    }

    return Response.json(approvals);
  } catch (err) {
    console.error('[api/approvals] GET error:', err);
    return Response.json(
      { error: 'Failed to fetch approvals' },
      { status: 500 },
    );
  }
}
