import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Operator-alert helper — shared Telegram delivery + cooldown gate for the
// fleet-resilience watchdogs (plan #1 cron-dispatch storm, #2 heartbeat
// stale, #4 doctor delta) and the existing spawn-failure storm detector.
//
// Each caller picks a `cooldownKey` and `cooldownMs`. We persist
// `state/.operator-alert-state.json` keyed by that string so a daemon
// restart doesn't re-flood. Individual callers may still gate on their
// own logic upstream (e.g. spawn-failure-tracker's daemon-exit cooldown);
// this is the shared *alert-send* gate.
//
// Cred lookup matches the env-or-`.env` resolution that
// `spawn-failure-tracker.ts` used to do inline. Pre-extraction that helper
// was duplicated against daemon/index.ts on purpose to keep the test graph
// small; with three callers landing this becomes the single source of truth.
// ---------------------------------------------------------------------------

export type OperatorAlertKind =
  | 'spawn_storm'
  | 'cron_dispatch_storm'
  | 'heartbeat_stale'
  | 'doctor_delta'
  | 'port_collision';

export type OperatorAlertSeverity = 'WARN' | 'CRITICAL';

export interface OperatorAlert {
  kind: OperatorAlertKind;
  severity: OperatorAlertSeverity;
  agent?: string;
  /** User-facing body, ≤500 chars in practice. Sent as Telegram text. */
  text: string;
  /** Dedupe bucket. Suggested shape: `<kind>-<scope>` e.g. `heartbeat_stale-boss`. */
  cooldownKey: string;
  /** Default 30 min. Re-alerts for the same key within the window are dropped. */
  cooldownMs?: number;
}

export interface OperatorAlertResult {
  sent: boolean;
  reason?: 'cooldown' | 'no_creds' | 'send_failed' | 'ok';
}

interface OperatorAlertState {
  /** keyed by cooldownKey, value is ISO timestamp of last send */
  lastSentAt: Record<string, string>;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const TELEGRAM_SEND_TIMEOUT_MS = 3000;

export function operatorAlertStatePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.operator-alert-state.json');
}

export function readOperatorAlertState(ctxRoot: string): OperatorAlertState {
  const p = operatorAlertStatePath(ctxRoot);
  if (!existsSync(p)) return { lastSentAt: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as OperatorAlertState;
    return { lastSentAt: parsed.lastSentAt ?? {} };
  } catch {
    return { lastSentAt: {} };
  }
}

function writeOperatorAlertState(ctxRoot: string, state: OperatorAlertState): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    atomicWriteSync(operatorAlertStatePath(ctxRoot), JSON.stringify(state, null, 2));
  } catch {
    console.error('[operator-alert] Failed to persist alert-state (non-fatal)');
  }
}

/**
 * Resolve Telegram creds via env-or-`.env` scan. Hoisted out of
 * spawn-failure-tracker.ts so all watchdog callers share one lookup.
 *
 * 1. Prefer `CTX_OPERATOR_CHAT_ID` + `CTX_OPERATOR_BOT_TOKEN` env vars.
 * 2. Fall back to scanning `orgs/<org>/agents/<agent>/.env` for the first
 *    file with `BOT_TOKEN=...` + `CHAT_ID=...` (env CHAT_ID wins if set).
 */
export function resolveOperatorChatCreds(
  frameworkRoot: string,
): { chatId: string; botToken: string } | null {
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
 * Send via curl + spawnSync. Sync (matches spawn-failure-tracker's
 * pre-extraction behavior — we may be about to process.exit). 3s timeout.
 * Best-effort: failure is non-fatal.
 */
function sendTelegramBestEffort(creds: { chatId: string; botToken: string }, text: string): boolean {
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${text}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Fire an operator alert. Returns `{sent: false, reason: 'cooldown'}` when
 * a previous alert with the same `cooldownKey` fired within `cooldownMs`.
 * Persists the send timestamp on success.
 *
 * NB: sync by design — matches the pre-extraction spawn-failure-tracker
 * path which may be invoked right before process.exit(). Async would
 * trigger a `Promise.resolve()` round-trip the daemon doesn't have time
 * for in the storm-detector hot path.
 */
export function emitOperatorAlert(
  ctxRoot: string,
  frameworkRoot: string,
  alert: OperatorAlert,
): OperatorAlertResult {
  const cooldownMs = alert.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const state = readOperatorAlertState(ctxRoot);
  const lastSent = state.lastSentAt[alert.cooldownKey];
  if (lastSent) {
    const elapsed = Date.now() - Date.parse(lastSent);
    if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
      return { sent: false, reason: 'cooldown' };
    }
  }

  const creds = resolveOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[operator-alert] no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return { sent: false, reason: 'no_creds' };
  }

  // Persist the cooldown marker BEFORE attempting the send. Even if the
  // send fails or the daemon dies mid-curl, the next call respects the
  // cooldown — preventing thrash. The caller learns of send failure via
  // the return value and can decide whether to retry.
  state.lastSentAt[alert.cooldownKey] = new Date().toISOString();
  writeOperatorAlertState(ctxRoot, state);

  const sent = sendTelegramBestEffort(creds, alert.text);
  if (!sent) {
    console.error('[operator-alert] Telegram send failed (non-fatal)');
    return { sent: false, reason: 'send_failed' };
  }
  console.error(`[operator-alert] ${alert.severity} alert sent: kind=${alert.kind} key=${alert.cooldownKey}`);
  return { sent: true, reason: 'ok' };
}
