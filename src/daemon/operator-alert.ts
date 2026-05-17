// Shared helpers for sending operator alerts via Telegram from the daemon.
//
// Originally these lived as private functions in `src/daemon/index.ts` for
// the daemon-level crash-loop alert path. Task #60 needs the same primitive
// from `agent-process.ts` to fire an auth-halt alert when the rate-limit /
// auth circuit breaker decides an agent must stop restarting. Rather than
// duplicate or cyclic-import, the credential resolver + alert sender move
// here and `daemon/index.ts` re-exports them for callers that already imported
// from there.

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const TELEGRAM_SEND_TIMEOUT_MS = 3000; // bounded — we're already in a degraded state

export interface OperatorChatCreds { chatId: string; botToken: string }

/**
 * Resolve operator Telegram credentials with two strategies:
 *
 *   1. CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN env vars (production).
 *   2. Fall back to the first agent .env on disk that carries a valid-format
 *      BOT_TOKEN + CHAT_ID. Good enough for single-operator installs — alert
 *      still lands SOMEWHERE visible to the operator.
 *
 * Returns null when nothing usable is found; callers MUST treat null as
 * "operator can't be reached" and log a fallback message themselves.
 */
export function getOperatorChatCreds(frameworkRoot: string): OperatorChatCreds | null {
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Synchronous best-effort Telegram send via curl. Bounded at 3s so a hung
 * network connection can't stall caller paths (which are themselves in
 * degraded / crash flows). Returns true on HTTP-2xx-ish success, false on
 * any other outcome. Never throws.
 */
export function sendOperatorTelegramBestEffort(
  frameworkRoot: string,
  message: string,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[operator-alert] No operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper preserving the previous public signature in
 * daemon/index.ts so external callers keep working through the refactor.
 */
export function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  const ok = sendOperatorTelegramBestEffort(frameworkRoot, message);
  if (ok) {
    console.error('[daemon] Crash-loop alert sent to operator chat');
  } else {
    console.error('[daemon] Crash-loop alert send failed (non-fatal)');
  }
  return ok;
}

/**
 * Task #60: dedicated wrapper for the auth-storm halt alert fired from the
 * restart circuit breaker. Distinct surface so the message format stays
 * consistent across agents and tests can assert against a known string.
 */
export function sendAuthHaltAlertBestEffort(
  frameworkRoot: string,
  agentName: string,
  recentAuthCount: number,
): boolean {
  const message =
    `🚨 AUTH-STORM HALT: agent "${agentName}" stopped after ${recentAuthCount} ` +
    `authentication failures in 15 min.\n` +
    `Likely cause: Anthropic 401 / "Not logged in" — auto-restart disabled to ` +
    `avoid burning quota.\n` +
    `Action: log in (cortextos login) on the agent's host, then run ` +
    `\`cortextos start ${agentName}\` to resume.`;
  return sendOperatorTelegramBestEffort(frameworkRoot, message);
}
