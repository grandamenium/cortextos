import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sql } from '@/lib/db';
import { verifyTotp, generateRecoveryCodes } from '@/lib/totp';
import type { User } from '@/lib/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let code: string;
  try {
    const body = await req.json();
    code = (body.code ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!code) return NextResponse.json({ error: 'Code required' }, { status: 400 });

  const [user] = await sql<Pick<User, 'totp_secret' | 'totp_enabled'>[]>`
    SELECT totp_secret, totp_enabled FROM users WHERE id = ${session.user.id}
  `;

  if (!user?.totp_secret) {
    return NextResponse.json({ error: 'No pending TOTP setup. Call /setup first.' }, { status: 400 });
  }

  const valid = verifyTotp(code, user.totp_secret);
  if (!valid) return NextResponse.json({ error: 'Invalid code' }, { status: 400 });

  await sql`UPDATE users SET totp_enabled = 1 WHERE id = ${session.user.id}`;
  const recoveryCodes = await generateRecoveryCodes(Number(session.user.id));

  return NextResponse.json({ ok: true, recoveryCodes });
}
