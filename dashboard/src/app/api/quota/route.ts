import { fetchQuotaSnapshot } from '@/lib/quota';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await fetchQuotaSnapshot();
  if (!snapshot) {
    return Response.json(
      { error: 'No quota data available yet.' },
      { status: 503 },
    );
  }

  return Response.json(snapshot);
}
