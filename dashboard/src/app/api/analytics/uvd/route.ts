import { NextRequest, NextResponse } from 'next/server';
import { getUvdMetrics } from '@/lib/data/reports';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/uvd?org=revops-global&days=14
 * Returns latest UVD snapshot and 14-day trend history.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get('org') ?? 'revops-global';
  const days = parseInt(searchParams.get('days') ?? '14', 10);

  try {
    const data = getUvdMetrics(org, days);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load UVD metrics', detail: String(err) },
      { status: 500 }
    );
  }
}
