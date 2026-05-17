import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sql } from '@/lib/db';
import { generateTotpSetup } from '@/lib/totp';
import type { User } from '@/lib/types';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [user] = await sql<Pick<User, 'username' | 'totp_enabled'>[]>`
    SELECT username, totp_enabled FROM users WHERE id = ${session.user.id}
  `;

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (user.totp_enabled) return NextResponse.json({ error: 'TOTP already enabled' }, { status: 409 });

  const setup = await generateTotpSetup(user.username);

  await sql`UPDATE users SET totp_secret = ${setup.secret} WHERE id = ${session.user.id}`;

  return NextResponse.json({ qrDataUrl: setup.qrDataUrl, secret: setup.secret });
}
