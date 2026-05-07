import { NextRequest } from 'next/server';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const search = new URL(request.url).search;
  try {
    return await proxyHermesDashboard(`/api/jobs/${encodeURIComponent(id)}/output${search}`);
  } catch (error) {
    return Response.json({ outputs: [], error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
