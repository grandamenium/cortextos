import { NextRequest } from 'next/server';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const search = new URL(request.url).searchParams;
  const sessionKey = search.get('sessionKey') ?? '';
  if (!sessionKey) return Response.json({ error: 'sessionKey is required' }, { status: 400 });
  try {
    return await proxyHermesDashboard(`/api/context-usage?sessionKey=${encodeURIComponent(sessionKey)}`);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
