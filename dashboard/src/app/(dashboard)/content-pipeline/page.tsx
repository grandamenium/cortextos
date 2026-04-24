import { ContentPipelineDashboard } from '@/components/content-pipeline/dashboard';

function getToday() {
  return new Date().toISOString().split('T')[0];
}

export const dynamic = 'force-dynamic';
export const revalidate = 60; // revalidate every 60 seconds

async function fetchPipelineData(date: string) {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/content-pipeline?date=${date}`, {
      cache: 'no-store'
    });
    return response.json();
  } catch (error) {
    console.error('Failed to fetch pipeline data:', error);
    return {
      date,
      candidates: [],
      selections: {
        1: { type: 1, status: 'empty' },
        2: { type: 2, status: 'empty' },
        3: { type: 3, status: 'empty' },
        4: { type: 4, status: 'empty' }
      },
      filtered: [],
      approvalStatus: 'pending'
    };
  }
}

export default async function ContentPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const dateParam = typeof params.date === 'string' ? params.date : undefined;
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : getToday();

  const pipelineData = await fetchPipelineData(date);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Content Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage content sources, evaluate candidates, and select topics for briefs.
        </p>
      </div>

      <ContentPipelineDashboard data={pipelineData} date={date} />
    </div>
  );
}
