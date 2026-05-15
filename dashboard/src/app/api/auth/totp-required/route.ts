import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { User } from '@/lib/types';

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get('username')?.trim();
  if (!username) return NextResponse.json({ required: false });

  const user = db
    .prepare('SELECT totp_enabled FROM users WHERE username = ?')
    .get(username) as Pick<User, 'totp_enabled'> | undefined;

  // Return false for unknown users — same as disabled, no enumeration
  return NextResponse.json({ required: user?.totp_enabled === 1 });
}
