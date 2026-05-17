import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sql } from '@/lib/db';

export async function POST(req: NextRequest) {
  let token: string, password: string;
  try {
    const body = await req.json();
    token = (body.token ?? '').trim();
    password = body.password ?? '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!token || !password) {
    return NextResponse.json({ error: 'Token and password required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const now = Date.now();
  const [reset] = await sql<{ user_id: number }[]>`
    SELECT user_id FROM password_resets WHERE token = ${token} AND used = 0 AND expires_at > ${now}
  `;

  if (!reset) {
    return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 400 });
  }

  const hash = await bcrypt.hash(password, 12);
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${reset.user_id}`;
  await sql`UPDATE password_resets SET used = 1 WHERE token = ${token}`;

  return NextResponse.json({ ok: true });
}
