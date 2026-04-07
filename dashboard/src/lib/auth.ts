// cortextOS Dashboard - NextAuth v5 configuration
// Credentials provider backed by SQLite users table

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { checkRateLimit, resetRateLimit } from './rate-limit';
import type { User } from './types';

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // Force simple cookie names without __Secure- / __Host- prefixes.
  // NextAuth v5 auto-enables these for HTTPS (including Cloudflare tunnels via
  // X-Forwarded-Proto), but tunnel proxies may not forward Secure-prefixed
  // cookies reliably. The middleware checks for authjs.session-token, so this
  // must stay consistent.
  cookies: {
    sessionToken: {
      name: 'authjs.session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    csrfToken: {
      name: 'authjs.csrf-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    callbackUrl: {
      name: 'authjs.callback-url',
      options: { sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    pkceCodeVerifier: {
      name: 'authjs.pkce.code_verifier',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    state: {
      name: 'authjs.state',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    nonce: {
      name: 'authjs.nonce',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        // Security (H8): Rate limit auth attempts to prevent brute force.
        // Only trust x-forwarded-for when behind a known proxy (TRUST_PROXY=true);
        // otherwise it is trivially spoofable.
        const trustProxy = process.env.TRUST_PROXY === 'true';
        const headers = (request as Request | undefined)?.headers;
        const ip = trustProxy
          ? (headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0')
          : (headers?.get('x-real-ip') ?? '0.0.0.0');

        const { allowed } = checkRateLimit(ip);
        if (!allowed) {
          throw new Error('Too many attempts. Please try again later.');
        }

        if (!credentials?.username || !credentials?.password) return null;

        // Seed admin user on first auth attempt if no users exist
        await seedAdminUser();

        const user = db
          .prepare('SELECT * FROM users WHERE username = ?')
          .get(credentials.username as string) as User | undefined;
        if (!user) return null;

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password_hash
        );
        if (!valid) return null;

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

/** Seed admin user from env vars, or sync password if it changed */
export async function seedAdminUser(): Promise<void> {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM users')
    .get() as { count: number };

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

  if (row.count > 0) {
    // Sync password: if ADMIN_PASSWORD env var changed, update the stored hash
    const user = db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(username) as { password_hash: string } | undefined;
    if (user) {
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        const hash = await bcrypt.hash(password, 12);
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
        console.log(`[auth] Admin password updated from environment`);
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
