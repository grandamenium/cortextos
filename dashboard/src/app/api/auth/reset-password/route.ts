import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

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
  const reset = db
    .prepare('SELECT user_id FROM password_resets WHERE token = ? AND used = 0 AND expires_at > ?')
    .get(token, now) as { user_id: number } | undefined;

  if (!reset) {
    return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 400 });
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, reset.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);

  return NextResponse.json({ ok: true });
}
