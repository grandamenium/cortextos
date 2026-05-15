// Security (H8): SQLite-backed rate limiter — survives server restarts.
// Fails closed if db is unavailable (denying is safer than allowing unlimited attempts).
import { execSync } from 'node:child_process';
import { db } from '@/lib/db';

const MAX = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Threshold for failed-login Telegram alert (Phase 5)
const FAIL_ALERT_THRESHOLD = 3;
// Key prefix distinguishes failed-auth counters from general rate-limit counters
const FAIL_PREFIX = 'fail:';

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();

  try {
    db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);

    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE ip = ?').get(ip) as
      | { count: number; reset_at: number }
      | undefined;

    if (!row) {
      db.prepare('INSERT INTO rate_limits (ip, count, reset_at) VALUES (?, 1, ?)').run(
        ip,
        now + WINDOW_MS,
      );
      return { allowed: true };
    }

    if (row.count >= MAX) {
      return { allowed: false, retryAfter: Math.ceil((row.reset_at - now) / 1000) };
    }

    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').run(ip);
    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] DB error, failing closed (denying request):', err);
    return { allowed: false, retryAfter: 60 };
  }
}

export function resetRateLimit(ip: string): void {
  try {
    db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
  } catch (err) {
    console.error('[rate-limit] DB error on reset:', err);
  }
}

const FORGOT_PW_MAX = 3;
const FORGOT_PW_PREFIX = 'forgotpw:';

/** Rate-limit forgot-password requests: 3 per 15min per IP. */
export function checkForgotPasswordLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const key = `${FORGOT_PW_PREFIX}${ip}`;
  try {
    db.prepare('DELETE FROM rate_limits WHERE ip = ? AND reset_at <= ?').run(key, now);
    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE ip = ?').get(key) as
      | { count: number; reset_at: number }
      | undefined;
    if (!row) {
      db.prepare('INSERT INTO rate_limits (ip, count, reset_at) VALUES (?, 1, ?)').run(key, now + WINDOW_MS);
      return { allowed: true };
    }
    if (row.count >= FORGOT_PW_MAX) {
      return { allowed: false, retryAfter: Math.ceil((row.reset_at - now) / 1000) };
    }
    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').run(key);
    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] DB error on forgot-password check:', err);
    return { allowed: false, retryAfter: 60 };
  }
}

/**
 * Record a failed login attempt for an IP.
 * Sends a Telegram alert when FAIL_ALERT_THRESHOLD is first crossed in a 15-min window.
 * Fire-and-forget — never throws.
 */
export function recordFailedLogin(ip: string, username: string): void {
  const now = Date.now();
  const key = `${FAIL_PREFIX}${ip}`;

  try {
    db.prepare('DELETE FROM rate_limits WHERE ip = ? AND reset_at <= ?').run(key, now);

    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE ip = ?').get(key) as
      | { count: number; reset_at: number }
      | undefined;

    let newCount: number;
    if (!row) {
      db.prepare('INSERT INTO rate_limits (ip, count, reset_at) VALUES (?, 1, ?)').run(
        key,
        now + WINDOW_MS,
      );
      newCount = 1;
    } else {
      db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').run(key);
      newCount = row.count + 1;
    }

    // Alert exactly when threshold is first crossed — not on every subsequent attempt
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
