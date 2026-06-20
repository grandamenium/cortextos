/**
 * Best-effort operator alerting over Telegram.
 *
 * Extracted so both the crash-loop path (daemon/index.ts) and the
 * VaultLivenessWatchdog share ONE credential resolver + sender. Every send is
 * best-effort and bounded — a missing/unreachable chat never throws and never
 * blocks the caller.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const TELEGRAM_SEND_TIMEOUT_MS = 3000; // bounded — alerts must never hang the daemon

/**
 * Resolve operator-chat credentials.
 *  1. Explicit env (recommended for production): CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN.
 *  2. Fallback: the first agent .env under `<frameworkRoot>/orgs/<org>/agents/<agent>` — good
 *     enough for small single-operator installs so the alert still lands somewhere visible.
 */
export function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
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
 * Send a one-off operator alert. Returns true on a successful curl exit, false
 * otherwise (no creds, network error, non-zero status). Never throws.
 */
export function sendOperatorAlertBestEffort(frameworkRoot: string, message: string): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error(
      '[operator-alert] no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)',
    );
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
    return r.status === 0;
  } catch {
    return false;
  }
}
