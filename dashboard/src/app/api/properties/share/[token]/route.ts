import { NextRequest } from 'next/server';
import { getPropertyByShareToken } from '@/lib/data/properties';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const property = getPropertyByShareToken(token);
  if (!property) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  // Strip share_token from public response
  const { share_token: _st, ...safe } = property;
  return Response.json(safe);
}
