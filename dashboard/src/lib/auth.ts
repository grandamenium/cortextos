// cortextOS Dashboard - NextAuth v5 configuration
// Credentials provider backed by Postgres users table

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { sql } from './db';
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

        const { allowed } = await checkRateLimit(ip);
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

        const [user] = await sql<User[]>`SELECT * FROM users WHERE username = ${credentials.username as string}`;
        if (!user) {
          await recordFailedLogin(ip, credentials.username as string);
          return null;
        }

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password_hash
        );
        if (!valid) {
          await recordFailedLogin(ip, credentials.username as string);
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
            const recovered = await checkAndConsumeRecoveryCode(user.id, code);
            if (!recovered) {
              await recordFailedLogin(ip, credentials.username as string);
              return null;
            }
          }
        }

        // Auth successful — reset rate limit counter
        await resetRateLimit(ip);

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
  const [row] = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM users`;
  const count = Number(row?.count ?? 0);

  // Early return: users already exist and no password sync requested.
  if (count > 0 && process.env.SYNC_ADMIN_PASSWORD !== 'true') {
    return;
  }

  const username = process.env.ADMIN_USERNAME ?? 'admin';

  // Security (H8): Do not fall back to hardcoded password.
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('ADMIN_PASSWORD environment variable is required but not set.');
  }
  const KNOWN_DEFAULTS = ['cortextos', 'password', 'admin', 'changeme'];
  if (process.env.NODE_ENV === 'production' && KNOWN_DEFAULTS.includes(password)) {
    throw new Error('ADMIN_PASSWORD is a known default. Set a strong password in .env.local');
  }

  if (count > 0) {
    // Opt-in password sync: only update stored hash when SYNC_ADMIN_PASSWORD=true.
    const [user] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE username = ${username}`;
    if (user) {
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        const hash = await bcrypt.hash(password, 12);
        await sql`UPDATE users SET password_hash = ${hash} WHERE username = ${username}`;
        console.log(`[auth] Admin password updated from environment (SYNC_ADMIN_PASSWORD=true)`);
      }
    }
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await sql`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash})`;
  console.log(`[auth] Seeded admin user: ${username}`);
}
