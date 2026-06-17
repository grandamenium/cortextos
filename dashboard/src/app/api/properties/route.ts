import { NextRequest } from 'next/server';
import { getProperties } from '@/lib/data/properties';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || undefined;

  try {
    const properties = getProperties(org);
    return Response.json(properties);
  } catch (err) {
    console.error('[api/properties] GET error:', err);
    return Response.json({ error: 'Failed to fetch properties' }, { status: 500 });
  }
}
