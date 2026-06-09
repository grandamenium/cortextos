export const dynamic = 'force-dynamic';

import { TrendingList } from '@/components/trending/trending-list';
import { getTrending, isValidTrendingDate } from '@/lib/data/trending';

export default async function TrendingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const requestedDate = typeof params.date === 'string' && isValidTrendingDate(params.date)
    ? params.date
    : undefined;
  const data = getTrending(requestedDate);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Trending</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Daily trending repos with STEAL/SKIP verdicts mapped to our stack.
        </p>
      </div>

      <TrendingList
        date={data.date}
        availableDates={data.availableDates}
        picks={data.picks}
      />
    </div>
  );
}
