import { NextRequest } from 'next/server';
import { getTrending, isValidTrendingDate } from '@/lib/data/trending';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const requestedDate = request.nextUrl.searchParams.get('date') ?? undefined;
    const data = getTrending(isValidTrendingDate(requestedDate) ? requestedDate : undefined);
    return Response.json(data);
  } catch {
    return Response.json({ date: null, availableDates: [], picks: [] });
  }
}
