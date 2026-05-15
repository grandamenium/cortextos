// cortextOS Dashboard - NextAuth v5 configuration
// Credentials provider backed by SQLite users table

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { checkRateLimit, resetRateLimit, recordFailedLogin } from './rate-limit';
import { verifyTurnstile } from './turnstile';
import type { User } from './types';

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // Let auth.js infer cookie names from AUTH_URL — on HTTPS it will automatically
  // use __Secure- prefixed names (__Secure-authjs.csrf-token etc.), which is
  // required for CSRF validation to pass in a browser. Hardcoding unprefixed names
  // breaks the CSRF lookup when auth.js is serving HTTPS via Cloudflare tunnel.
  // Middleware checks both authjs.session-token AND __Secure-authjs.session-token.
  cookies: {
    sessionToken: {
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    csrfToken: {
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    callbackUrl: {
      options: { sameSite: 'lax', path: '/' },
    },
    pkceCodeVerifier: {
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    state: {
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    nonce: {
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
        totp_code: { label: 'Authenticator Code', type: 'text' },
        turnstileToken: { label: 'Turnstile', type: 'text' },
      },
      async authorize(credentials, request) {
        // Security (H8): Rate limit auth attempts to prevent brute force.
        // Only trust x-forwarded-for when behind a known proxy (TRUST_PROXY=true);
        // otherwise it is trivially spoofable.
        const trustProxy = process.env.TRUST_PROXY === 'true';
        const headers = (request as Request | undefined)?.headers;
        const ip = trustProxy
          ? (headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0')
          // CF-Connecting-IP is set by Cloudflare and is not spoofable from outside CF
          : (headers?.get('x-real-ip') ?? headers?.get('cf-connecting-ip') ?? '0.0.0.0');

        const { allowed } = checkRateLimit(ip);
        if (!allowed) {
          throw new Error('Too many attempts. Please try again later.');
        }

        if (!credentials?.username || !credentials?.password) return null;

        // Turnstile verification (bypassed when TURNSTILE_SECRET_KEY not set)
        const turnstileOk = await verifyTurnstile(credentials.turnstileToken as string | undefined);
        if (!turnstileOk) {
          throw new Error('CAPTCHA verification failed. Please try again.');
        }

        // Seed admin user on first auth attempt if no users exist
        await seedAdminUser();

        const user = db
          .prepare('SELECT * FROM users WHERE username = ?')
          .get(credentials.username as string) as User | undefined;
        if (!user) {
          recordFailedLogin(ip, credentials.username as string);
          return null;
        }

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password_hash
        );
        if (!valid) {
          recordFailedLogin(ip, credentials.username as string);
          return null;
        }

        // TOTP verification (only when enabled)
        if (user.totp_enabled) {
          const code = ((credentials as Record<string, unknown>).totp_code as string | undefined)?.trim();
          if (!code) return null;

          const { verifyTotp } = await import('./totp');
          const totpValid = user.totp_secret
            ? verifyTotp(code, user.totp_secret)
            : false;

          if (!totpValid) {
            // Check one-time recovery codes
            const { checkAndConsumeRecoveryCode } = await import('./totp');
            const recovered = checkAndConsumeRecoveryCode(user.id, code);
            if (!recovered) {
              recordFailedLogin(ip, credentials.username as string);
              return null;
            }
          }
        }

        // Auth successful — reset rate limit counter
        resetRateLimit(ip);

        return {
          id: String(user.id),
          name: user.username,
        };
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
    authorized({ auth: session }) {
      return !!session;
    },
  },
});

/** Seed admin user from env vars, or sync password if SYNC_ADMIN_PASSWORD=true */
export async function seedAdminUser(): Promise<void> {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM users')
    .get() as { count: number };

  // Early return: users already exist and no password sync requested.
  // Do NOT validate ADMIN_PASSWORD here — existing deployments may not have it set,
  // and we don't need it when there is nothing to seed or sync.
  if (row.count > 0 && process.env.SYNC_ADMIN_PASSWORD !== 'true') {
    return;
  }

  const username = process.env.ADMIN_USERNAME ?? 'admin';

  // Security (H8): Do not fall back to hardcoded password.
  // Only validate when we actually need the password (seeding or syncing).
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('ADMIN_PASSWORD environment variable is required but not set.');
  }
  const KNOWN_DEFAULTS = ['cortextos', 'password', 'admin', 'changeme'];
  if (process.env.NODE_ENV === 'production' && KNOWN_DEFAULTS.includes(password)) {
    throw new Error('ADMIN_PASSWORD is a known default. Set a strong password in .env.local');
  }

  if (row.count > 0) {
    // Opt-in password sync: only update stored hash when SYNC_ADMIN_PASSWORD=true.
    // This prevents the dashboard from silently overwriting a password that was
    // changed through the UI on every restart.
    const user = db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(username) as { password_hash: string } | undefined;
    if (user) {
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        const hash = await bcrypt.hash(password, 12);
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
        console.log(`[auth] Admin password updated from environment (SYNC_ADMIN_PASSWORD=true)`);
      }
    }
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    username,
    hash
  );

  console.log(`[auth] Seeded admin user: ${username}`);
}
