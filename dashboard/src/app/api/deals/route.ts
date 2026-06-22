import { NextRequest } from 'next/server';
import { getDeals, updateDeal } from '@/lib/data/deals';

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

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { id: string; org: string; [key: string]: unknown };
    const { id, org, ...update } = body;
    if (!id || !org) return Response.json({ error: 'id and org are required' }, { status: 400 });
    const updated = updateDeal(id, org, update);
    if (!updated) return Response.json({ error: 'Deal not found' }, { status: 404 });
    return Response.json(updated);
  } catch (err) {
    console.error('[api/deals] PATCH error:', err);
    return Response.json({ error: 'Failed to update deal' }, { status: 500 });
  }
}
