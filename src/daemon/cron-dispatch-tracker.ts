import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { emitOperatorAlert } from './operator-alert.js';

// ---------------------------------------------------------------------------
// Fleet-resilience plan #1 — cron-dispatch storm detector.
//
// Post-mortem of the 2026-05-14 9-hour silent outage: when `injectAgent()`
// returned false the cron-scheduler logged a WARN and advanced the slot.
// The right reaction for a one-off miss; silent over hours when the same
// agent stayed down. May 14 had 8+ different crons fire-and-fail every
// 30 min for 9h with zero operator-facing signal.
//
// This tracker fires a CRITICAL operator alert when ≥3 DISTINCT cron names
// fail to dispatch to the same agent inside a 30-min window. Distinctness
// is the load-bearing dimension — same cron looping doesn't count, because
// a single hook firing repeatedly is already covered by the cron-scheduler's
// advance-the-slot logic.
//
// Modeled on spawn-failure-tracker.ts (single-write atomicity around the
// cooldown marker, ring-buffer cap on events).
// ---------------------------------------------------------------------------

export interface CronDispatchEvent {
  ts: string;
  agent: string;
  cronName: string;
}

export interface CronDispatchHistory {
  events: CronDispatchEvent[];
  lastAlertAt?: string;
}

export const CRON_DISPATCH_HISTORY_MAX = 100;
export const CRON_DISPATCH_WINDOW_MS = 30 * 60 * 1000;          // 30 min detection window
export const CRON_DISPATCH_DISTINCT_THRESHOLD = 3;              // ≥3 distinct crons trips
export const CRON_DISPATCH_COOLDOWN_MS = 60 * 60 * 1000;        // 60 min between alerts per agent

export function cronDispatchHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.cron-dispatch-failure-history.json');
}

export function readCronDispatchHistory(ctxRoot: string): CronDispatchHistory {
  const p = cronDispatchHistoryPath(ctxRoot);
  if (!existsSync(p)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CronDispatchHistory;
    return { events: parsed.events ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { events: [] };
  }
}

export function writeCronDispatchHistory(ctxRoot: string, history: CronDispatchHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    atomicWriteSync(cronDispatchHistoryPath(ctxRoot), JSON.stringify(history, null, 2));
  } catch {
    console.error('[daemon] Failed to persist cron-dispatch-failure history (non-fatal)');
  }
}

function appendEvent(
  history: CronDispatchHistory,
  agent: string,
  cronName: string,
): CronDispatchHistory {
  history.events.push({ ts: new Date().toISOString(), agent, cronName });
  if (history.events.length > CRON_DISPATCH_HISTORY_MAX) {
    history.events = history.events.slice(-CRON_DISPATCH_HISTORY_MAX);
  }
  return history;
}

/**
 * Count DISTINCT cron names that failed to dispatch to `agent` in the last
 * CRON_DISPATCH_WINDOW_MS. Same cron repeating counts once. This is the
 * key signal — a single hook in a loop is not a storm; many different
 * hooks failing to reach the same agent IS.
 */
export function countRecentDistinctCrons(history: CronDispatchHistory, agent: string): string[] {
  const windowStart = Date.now() - CRON_DISPATCH_WINDOW_MS;
  const seen = new Set<string>();
  for (const e of history.events) {
    if (e.agent !== agent) continue;
    if (Date.parse(e.ts) < windowStart) continue;
    seen.add(e.cronName);
  }
  return [...seen];
}

export function shouldEscalate(
  history: CronDispatchHistory,
  agent: string,
  threshold: number = CRON_DISPATCH_DISTINCT_THRESHOLD,
): boolean {
  const distinct = countRecentDistinctCrons(history, agent);
  if (distinct.length < threshold) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRON_DISPATCH_COOLDOWN_MS;
    if (Date.now() < cooldownEnd) return false;
  }
  return true;
}

export function buildEscalationMessage(
  history: CronDispatchHistory,
  agent: string,
): string {
  const crons = countRecentDistinctCrons(history, agent);
  return (
    `⚠️ Cron dispatch failure storm for agent "${agent}"\n` +
    `${crons.length} distinct cron(s) failed to inject in ` +
    `${CRON_DISPATCH_WINDOW_MS / 60_000} min: ${crons.join(', ')}\n` +
    `Likely fix: \`cortextos restart ${agent}\` or \`pm2 restart cortextos-daemon\``
  );
}

/**
 * Append the dispatch failure, decide whether to escalate, persist + fire the
 * operator alert in a single atomic write. Caller-controlled side effects
 * (no auto-exit; this is informational — the daemon stays up and crons keep
 * advancing, only escalation is gated).
 *
 * The escalation persists `lastAlertAt` BEFORE firing the alert so a daemon
 * crash mid-Telegram doesn't reset the cooldown.
 */
export function recordCronDispatchAndMaybeEscalate(
  ctxRoot: string,
  frameworkRoot: string,
  agent: string,
  cronName: string,
  /** Optional override for CRON_DISPATCH_DISTINCT_THRESHOLD. Falls back to
   *  the default when undefined. Wired from daemon.json's
   *  `cron_dispatch_storm_threshold` field. */
  threshold?: number,
): { escalated: boolean; history: CronDispatchHistory } {
  const history = appendEvent(readCronDispatchHistory(ctxRoot), agent, cronName);

  if (!shouldEscalate(history, agent, threshold)) {
    writeCronDispatchHistory(ctxRoot, history);
    return { escalated: false, history };
  }

  history.lastAlertAt = new Date().toISOString();
  writeCronDispatchHistory(ctxRoot, history);

  const message = buildEscalationMessage(history, agent);
  console.error(`[daemon] ${message}`);
  emitOperatorAlert(ctxRoot, frameworkRoot, {
    kind: 'cron_dispatch_storm',
    severity: 'CRITICAL',
    agent,
    text: message,
    cooldownKey: `cron_dispatch_storm-${agent}`,
    cooldownMs: CRON_DISPATCH_COOLDOWN_MS,
  });
  return { escalated: true, history };
}
