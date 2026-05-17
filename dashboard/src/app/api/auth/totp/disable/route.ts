import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { auth } from '@/lib/auth';
import { sql } from '@/lib/db';
import type { User } from '@/lib/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let password: string;
  try {
    const body = await req.json();
    password = body.password ?? '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!password) return NextResponse.json({ error: 'Password required to disable 2FA' }, { status: 400 });

  const [user] = await sql<Pick<User, 'password_hash'>[]>`
    SELECT password_hash FROM users WHERE id = ${session.user.id}
  `;

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return NextResponse.json({ error: 'Incorrect password' }, { status: 403 });

  await sql`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ${session.user.id}`;
  await sql`DELETE FROM totp_recovery_codes WHERE user_id = ${session.user.id}`;

  return NextResponse.json({ ok: true });
}
