// Security (H8): Postgres-backed rate limiter — survives server restarts.
// Fails closed if db is unavailable (denying is safer than allowing unlimited attempts).
import { execSync } from 'node:child_process';
import { sql } from '@/lib/db';

const MAX = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const FAIL_ALERT_THRESHOLD = 3;
const FAIL_PREFIX = 'fail:';

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Date.now();
  try {
    await sql`DELETE FROM rate_limits WHERE reset_at <= ${now}`;
    const [row] = await sql<{ count: number; reset_at: string }[]>`
      SELECT count, reset_at FROM rate_limits WHERE ip = ${ip}
    `;
    if (!row) {
      await sql`INSERT INTO rate_limits (ip, count, reset_at) VALUES (${ip}, 1, ${now + WINDOW_MS})`;
      return { allowed: true };
    }
    if (row.count >= MAX) {
      return { allowed: false, retryAfter: Math.ceil((Number(row.reset_at) - now) / 1000) };
    }
    await sql`UPDATE rate_limits SET count = count + 1 WHERE ip = ${ip}`;
    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] DB error, failing closed (denying request):', err);
    return { allowed: false, retryAfter: 60 };
  }
}

export async function resetRateLimit(ip: string): Promise<void> {
  try {
    await sql`DELETE FROM rate_limits WHERE ip = ${ip}`;
  } catch (err) {
    console.error('[rate-limit] DB error on reset:', err);
  }
}

const FORGOT_PW_MAX = 3;
const FORGOT_PW_PREFIX = 'forgotpw:';

export async function checkForgotPasswordLimit(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Date.now();
  const key = `${FORGOT_PW_PREFIX}${ip}`;
  try {
    await sql`DELETE FROM rate_limits WHERE ip = ${key} AND reset_at <= ${now}`;
    const [row] = await sql<{ count: number; reset_at: string }[]>`
      SELECT count, reset_at FROM rate_limits WHERE ip = ${key}
    `;
    if (!row) {
      await sql`INSERT INTO rate_limits (ip, count, reset_at) VALUES (${key}, 1, ${now + WINDOW_MS})`;
      return { allowed: true };
    }
    if (row.count >= FORGOT_PW_MAX) {
      return { allowed: false, retryAfter: Math.ceil((Number(row.reset_at) - now) / 1000) };
    }
    await sql`UPDATE rate_limits SET count = count + 1 WHERE ip = ${key}`;
    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] DB error on forgot-password check:', err);
    return { allowed: false, retryAfter: 60 };
  }
}

export async function recordFailedLogin(ip: string, username: string): Promise<void> {
  const now = Date.now();
  const key = `${FAIL_PREFIX}${ip}`;
  try {
    await sql`DELETE FROM rate_limits WHERE ip = ${key} AND reset_at <= ${now}`;
    const [row] = await sql<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE ip = ${key}
    `;
    let newCount: number;
    if (!row) {
      await sql`INSERT INTO rate_limits (ip, count, reset_at) VALUES (${key}, 1, ${now + WINDOW_MS})`;
      newCount = 1;
    } else {
      await sql`UPDATE rate_limits SET count = count + 1 WHERE ip = ${key}`;
      newCount = row.count + 1;
    }
    if (newCount === FAIL_ALERT_THRESHOLD) {
      sendFailedLoginAlert(ip, username, newCount);
    }
  } catch (err) {
    console.error('[rate-limit] DB error recording failed login:', err);
  }
}

function sendFailedLoginAlert(ip: string, username: string, count: number): void {
  const chatId = process.env.CTX_TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const msg = `Security alert: ${count} failed login attempts for user "${username}" from IP ${ip} in the last 15 minutes on dashboard.clicktoacquire.com`;
  try {
    execSync(`cortextos bus send-telegram ${chatId} "${msg.replace(/"/g, '\\"')}"`, {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch (err) {
    console.error('[rate-limit] Failed to send login alert via Telegram:', err);
  }
}
