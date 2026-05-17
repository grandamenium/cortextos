import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sql } from '@/lib/db';
import type { User } from '@/lib/types';
import { checkRateLimit, resetRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mobile - Mobile-friendly auth that returns JWT in response body
 *
 * Body: { username: string, password: string }
 * Returns: { token: string, user: { id: string, name: string } }
 */
export async function POST(request: NextRequest) {
  // Security (H8): Only trust x-forwarded-for when behind a known proxy.
  // Without TRUST_PROXY=true, x-forwarded-for is trivially spoofable.
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const ip = trustProxy
    ? (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown')
    : (request.headers.get('x-real-ip') ?? 'unknown');
  const { allowed, retryAfter } = await checkRateLimit(ip);
  if (!allowed) {
    return Response.json({ error: 'Too many attempts' }, { status: 429, headers: { 'Retry-After': String(retryAfter) } } as any);
  }

  // Security (H8/H13): No hardcoded JWT secret fallback.
  const JWT_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!JWT_SECRET) {
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return Response.json({ error: 'Username and password required' }, { status: 400 });
  }

  try {
    const [user] = await sql<User[]>`SELECT * FROM users WHERE username = ${username}`;

    if (!user) {
      // Constant-time defense: run a dummy bcrypt comparison so the response time
      // doesn't reveal whether the user exists.
      await bcrypt.compare(password, '$2a$12$00000000000000000000000000000000000000000000000000000');
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Auth successful — reset rate limit counter
    await resetRateLimit(ip);

    // Generate JWT
    const token = jwt.sign(
      { sub: String(user.id), name: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return Response.json({
      token,
      user: { id: String(user.id), name: user.username },
    });
  } catch (err) {
    console.error('[api/auth/mobile] Error:', err);
    return Response.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
