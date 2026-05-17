import { NextResponse } from 'next/server';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await syncAll();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const result = await syncAll();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
