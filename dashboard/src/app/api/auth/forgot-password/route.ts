import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { sql } from '@/lib/db';
import { checkForgotPasswordLimit } from '@/lib/rate-limit';
import { verifyTurnstile } from '@/lib/turnstile';
import type { User } from '@/lib/types';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function getIp(req: NextRequest): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

export async function POST(req: NextRequest) {
  const ip = getIp(req);
  const { allowed, retryAfter } = await checkForgotPasswordLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Try again later.' },
      { status: 429, headers: retryAfter ? { 'Retry-After': String(retryAfter) } : {} },
    );
  }

  let email: string, turnstileToken: string;
  try {
    const body = await req.json();
    email = (body.email ?? '').trim().toLowerCase();
    turnstileToken = body.turnstileToken ?? '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const captchaOk = await verifyTurnstile(turnstileToken);
  if (!captchaOk) {
    return NextResponse.json({ error: 'CAPTCHA verification failed. Please try again.' }, { status: 400 });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }

  // Always return 200 to prevent email enumeration
  const [user] = await sql<(User & { email?: string })[]>`
    SELECT id, username, email FROM users WHERE email = ${email}
  `;

  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    await sql`UPDATE password_resets SET used = 1 WHERE user_id = ${user.id} AND used = 0`;
    await sql`INSERT INTO password_resets (token, user_id, expires_at) VALUES (${token}, ${user.id}, ${expiresAt})`;

    const resetUrl = `${process.env.AUTH_URL ?? 'http://localhost:3000'}/reset-password?token=${token}`;

    await sendResetEmail(email, user.username, resetUrl);
  }

  return NextResponse.json({ ok: true });
}

async function sendResetEmail(to: string, username: string, resetUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL ?? 'auth@clicktoacquire.com';
  if (!apiKey) {
    console.error('[forgot-password] RESEND_API_KEY not set — cannot send reset email');
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: 'Reset your cortextOS Dashboard password',
      html: `
        <p>Hi ${username},</p>
        <p>You requested a password reset for your cortextOS Dashboard account.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a></p>
        <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        <p>— cortextOS</p>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[forgot-password] Resend API error:', res.status, body);
  }
}
