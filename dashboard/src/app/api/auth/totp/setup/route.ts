import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { generateTotpSetup } from '@/lib/totp';
import type { User } from '@/lib/types';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = db
    .prepare('SELECT username, totp_enabled FROM users WHERE id = ?')
    .get(session.user.id) as Pick<User, 'username' | 'totp_enabled'> | undefined;

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (user.totp_enabled) return NextResponse.json({ error: 'TOTP already enabled' }, { status: 409 });

  const setup = await generateTotpSetup(user.username);

  // Store secret temporarily (unverified) — will be confirmed on verify
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(setup.secret, session.user.id);

  return NextResponse.json({ qrDataUrl: setup.qrDataUrl, secret: setup.secret });
}
