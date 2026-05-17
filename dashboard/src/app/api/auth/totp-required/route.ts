import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import type { User } from '@/lib/types';

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get('username')?.trim();
  if (!username) return NextResponse.json({ required: false });

  const [user] = await sql<Pick<User, 'totp_enabled'>[]>`
    SELECT totp_enabled FROM users WHERE username = ${username}
  `;

  return NextResponse.json({ required: user?.totp_enabled === 1 });
}
