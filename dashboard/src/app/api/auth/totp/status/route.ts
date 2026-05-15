import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import type { User } from '@/lib/types';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = db
    .prepare('SELECT totp_enabled FROM users WHERE id = ?')
    .get(session.user.id) as Pick<User, 'totp_enabled'> | undefined;

  return NextResponse.json({ enabled: user?.totp_enabled === 1 });
}
