import { NextRequest } from 'next/server';
import { getDeals } from '@/lib/data/deals';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || undefined;

  try {
    const deals = getDeals(org);
    return Response.json(deals);
  } catch (err) {
    console.error('[api/deals] GET error:', err);
    return Response.json({ error: 'Failed to fetch deals' }, { status: 500 });
  }
}
