import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const response = await proxyHermesDashboard('/api/health');
    if (response.ok) return response;
    return Response.json({ ok: false, status: response.status }, { status: response.status });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
