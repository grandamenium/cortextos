import { NextRequest, NextResponse } from 'next/server';
import { getAgentSessions, type RangeDays } from '@/lib/usage-queries';
import { syncCostsLazy } from '@/lib/sync';

export const dynamic = 'force-dynamic';

function parseDays(value: string | null): RangeDays {
  if (value === 'all') return 'all';
  const n = Number(value);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 30;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get('days'));
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const refresh = url.searchParams.get('refresh') === '1';

  syncCostsLazy(refresh);

  const sessions = getAgentSessions(name, days, Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ sessions, range: days });
}
