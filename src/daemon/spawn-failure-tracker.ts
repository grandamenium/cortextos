import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Issue #07 phase 2: cross-agent spawn-failure storm detector.
//
// Phase 1 made AgentProcess.handleSpawnFailure retry + halt symmetric with
// handleExit, so a single agent failing to spawn no longer goes silently
// stuck. But the original incident (2026-05-14) was structurally different:
// the daemon's loaded node-pty native binding became stale after a pnpm
// install replaced `spawn-helper`. EVERY new spawn from that daemon failed.
// Per-agent retry can't fix that — it just hits the same broken binding.
//
// This module tracks `posix_spawnp failed` (or similar) events ACROSS
// agents. If ≥2 DISTINCT agents fail in a short window, that's the
// stale-binding signature and the only fix is a daemon respawn (PM2 reloads
// the native module fresh on `process.exit(1)`). The 30-min cooldown
// prevents PM2 thrash if a fresh daemon hits the same problem.
//
// Mirrors the pattern in daemon/index.ts (recordCrash / shouldSendCrashLoopAlert),
// but scoped to per-agent spawn events rather than daemon-process crashes.
// ---------------------------------------------------------------------------

export interface SpawnFailureEvent {
  ts: string;
  agent: string;
  err: string;
}
export interface SpawnFailureHistory {
  events: SpawnFailureEvent[];
  lastAlertAt?: string;
  lastSelfRestartAt?: string;
}

export const SPAWN_FAIL_HISTORY_MAX = 50;
export const SPAWN_FAIL_WINDOW_MS = 5 * 60 * 1000;        // 5 min detection window
export const SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD = 2;     // ≥2 agents trips escalation
export const SPAWN_FAIL_COOLDOWN_MS = 30 * 60 * 1000;      // 30 min between daemon self-restarts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;

export function spawnFailureHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.spawn-failure-history.json');
}

export function readSpawnFailureHistory(ctxRoot: string): SpawnFailureHistory {
  const p = spawnFailureHistoryPath(ctxRoot);
  if (!existsSync(p)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as SpawnFailureHistory;
    return {
      events: parsed.events ?? [],
      lastAlertAt: parsed.lastAlertAt,
      lastSelfRestartAt: parsed.lastSelfRestartAt,
    };
  } catch {
    return { events: [] };
  }
}

export function writeSpawnFailureHistory(ctxRoot: string, history: SpawnFailureHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(spawnFailureHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission — don't block recovery
    console.error('[daemon] Failed to persist spawn-failure history (non-fatal)');
  }
}

export function recordSpawnFailure(
  ctxRoot: string,
  agent: string,
  errStr: string,
): SpawnFailureHistory {
  const history = readSpawnFailureHistory(ctxRoot);
  history.events.push({
    ts: new Date().toISOString(),
    agent,
    err: errStr.slice(0, 500),
  });
  if (history.events.length > SPAWN_FAIL_HISTORY_MAX) {
    history.events = history.events.slice(-SPAWN_FAIL_HISTORY_MAX);
  }
  writeSpawnFailureHistory(ctxRoot, history);
  return history;
}

/**
 * Count DISTINCT agents that produced a spawn failure in the last
 * SPAWN_FAIL_WINDOW_MS. The same agent failing N times within the window
 * counts as 1 — Phase 1 already covers single-agent loops with crash budget +
 * exponential backoff. The cross-agent signal is what indicates a
 * daemon-wide problem (e.g. stale node-pty binding).
 */
export function countRecentDistinctAgents(history: SpawnFailureHistory): number {
  const windowStart = Date.now() - SPAWN_FAIL_WINDOW_MS;
  const seen = new Set<string>();
  for (const e of history.events) {
    if (Date.parse(e.ts) >= windowStart) seen.add(e.agent);
  }
  return seen.size;
}

/**
 * Should the daemon escalate (alert + self-exit for PM2 respawn)? True iff:
 *   - distinct agents in window ≥ threshold, AND
 *   - no escalation has fired within the cooldown window.
 *
 * The cooldown is critical: a fresh daemon may still hit the same problem
 * (e.g. node_modules left in a permanently broken state). Without cooldown
 * we'd thrash PM2 until max_restarts: 10 trips.
 */
export function shouldEscalate(history: SpawnFailureHistory): boolean {
  const distinct = countRecentDistinctAgents(history);
  if (distinct < SPAWN_FAIL_DISTINCT_AGENTS_THRESHOLD) return false;
  const now = Date.now();
  // lastSelfRestartAt is the binding event for cooldown — that's the action
  // that has consequences (PM2 thrash). lastAlertAt is a softer signal we
  // also record for observability but cooldown gates on the action.
  if (history.lastSelfRestartAt) {
    const cooldownEnd = Date.parse(history.lastSelfRestartAt) + SPAWN_FAIL_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

/**
 * Build the operator-facing alert text. Includes the distinct-agent count,
 * the most recent error signature, and the cooldown so the operator knows
 * what to expect.
 */
export function buildEscalationMessage(history: SpawnFailureHistory): string {
  const windowStart = Date.now() - SPAWN_FAIL_WINDOW_MS;
  const recent = history.events.filter(e => Date.parse(e.ts) >= windowStart);
  const distinctAgents = [...new Set(recent.map(e => e.agent))];
  const latest = recent[recent.length - 1];
  return (
    `🚨 CRITICAL: cortextos daemon spawn-failure storm\n` +
    `${distinctAgents.length} agents failed to spawn in ${SPAWN_FAIL_WINDOW_MS / 60_000} min: ${distinctAgents.join(', ')}\n` +
    `Latest err: ${latest?.err.slice(0, 200) ?? 'unknown'}\n` +
    `Daemon will exit for PM2 respawn to reload native bindings.\n` +
    `Next escalation in ${SPAWN_FAIL_COOLDOWN_MS / 60_000} min if the pattern continues.`
  );
}

/**
 * Best-effort Telegram alert to the operator chat. Uses curl via spawnSync
 * to stay synchronous (we're about to process.exit) and bounded (3s
 * timeout). Returns true on send success. Failure is non-fatal — the exit
 * still happens.
 *
 * Credential resolution mirrors getOperatorChatCreds in daemon/index.ts:
 *   1. CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN (preferred)
 *   2. First agent's .env BOT_TOKEN + CHAT_ID (fallback)
 *
 * Kept as a separate helper from daemon/index.ts's sendCrashLoopAlertBestEffort
 * so storm-detector tests don't pull in the entire daemon module graph.
 */
export function sendStormAlertBestEffort(
  frameworkRoot: string,
  message: string,
): boolean {
  const creds = resolveOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Spawn-failure storm alert: no operator chat configured ' +
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
      console.error('[daemon] Spawn-failure storm alert sent to operator chat');
      return true;
    }
    console.error('[daemon] Spawn-failure storm alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

function resolveOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
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
 * Glue: record this spawn failure, decide whether to escalate, and if so,
 * fire the operator alert + persist lastSelfRestartAt + return true (caller
 * is expected to process.exit(1) so PM2 respawns the daemon).
 *
 * Caller-controlled exit because tests need to assert the return value
 * without actually terminating the test runner.
 */
export function recordAndMaybeEscalate(
  ctxRoot: string,
  frameworkRoot: string,
  agent: string,
  errStr: string,
): { escalated: boolean; history: SpawnFailureHistory } {
  const history = recordSpawnFailure(ctxRoot, agent, errStr);
  if (!shouldEscalate(history)) {
    return { escalated: false, history };
  }
  const message = buildEscalationMessage(history);
  console.error(`[daemon] ${message}`);
  sendStormAlertBestEffort(frameworkRoot, message);
  history.lastAlertAt = new Date().toISOString();
  history.lastSelfRestartAt = history.lastAlertAt;
  writeSpawnFailureHistory(ctxRoot, history);
  return { escalated: true, history };
}
