import { fetchQuotaSnapshot } from '@/lib/quota';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await fetchQuotaSnapshot();
  if (!snapshot) {
    // True cold-boot: API failed AND no cache yet. The component renders this as "no data yet".
    return Response.json(
      { error: 'No quota data available yet (API failed and no cached last-good response).' },
      { status: 503 },
    );
  }
  // snapshot includes { stale: bool, cache_age_ms: number }. Component renders accordingly.
  return Response.json(snapshot);
}
