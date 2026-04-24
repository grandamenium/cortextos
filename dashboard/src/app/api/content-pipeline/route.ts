import { NextRequest, NextResponse } from 'next/server';
import { loadPipelineData } from '@/lib/content-pipeline';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    let date = searchParams.get('date');

    if (!date) {
      date = new Date().toISOString().split('T')[0];
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    const pipelineData = await loadPipelineData(date);
    return NextResponse.json(pipelineData);
  } catch (error) {
    console.error('Failed to load pipeline data:', error);
    return NextResponse.json(
      {
        date: new Date().toISOString().split('T')[0],
        candidates: [],
        selections: {
          1: { type: 1, status: 'empty' },
          2: { type: 2, status: 'empty' },
          3: { type: 3, status: 'empty' },
          4: { type: 4, status: 'empty' }
        },
        filtered: [],
        approvalStatus: 'pending'
      },
      { status: 200 }
    );
  }
}
