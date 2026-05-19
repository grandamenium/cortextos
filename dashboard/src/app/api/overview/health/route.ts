import { NextRequest } from 'next/server';
import { getHomeHealth, getHomeOrg } from '@/lib/agents';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const org = getHomeOrg(new URL(request.url).searchParams.get('org') ?? undefined);
  return Response.json(await getHomeHealth(org));
}
