/**
 * cron-liveness.ts — overdue detector for FastChecker (cron-register-reliability Phase 6).
 * Pure helpers; FastChecker owns restart/circuit escalation.
 */

import { parseDurationMs } from '../bus/cron-state.js';
import type { CronDefinition } from '../types/index.js';
import { CronScheduler, nextFireFromCron } from './cron-scheduler.js';

export interface CronLivenessInput {
  cron: CronDefinition;
  /** ISO last fire from cron-state.json if any */
  stateLastFire?: string;
  nowMs: number;
  /** Previous pollCycle time — used for wake-skip when gap is huge */
  lastCheckMs?: number;
}

export interface CronLivenessResult {
  overdue: boolean;
  reason?: string;
  wakeSkip?: boolean;
}

const GRACE_MS = Math.max(2 * CronScheduler.TICK_INTERVAL_MS, 5 * 60_000);

function parseIsoMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute interval length for interval schedules ("6h") or approximate for 5-field
 * by using previous scheduled slot distance from now via nextFireFromCron helpers.
 */
export function scheduleIntervalMs(cron: CronDefinition, nowMs: number): number | null {
  const s = (cron.schedule || '').trim();
  if (/^\d+[smhdw]$/i.test(s)) {
    try {
      return parseDurationMs(s);
    } catch {
      return null;
    }
  }
  // 5-field: use 24h as conservative interval for overdue threshold
  if (s.split(/\s+/).length === 5) {
    void nowMs;
    return 24 * 60 * 60_000;
  }
  return null;
}

export function evaluateCronLiveness(input: CronLivenessInput): CronLivenessResult {
  const { cron, stateLastFire, nowMs, lastCheckMs } = input;
  if (cron.enabled === false) return { overdue: false };

  if (lastCheckMs !== undefined && nowMs - lastCheckMs > 10 * 60_000) {
    return { overdue: false, wakeSkip: true };
  }

  const candidates = [
    parseIsoMs(cron.last_fired_at),
    parseIsoMs(cron.last_fire_attempted_at),
    parseIsoMs(stateLastFire),
  ].filter((n): n is number => n !== null);
  const baseline: number | null = candidates.length
    ? Math.max(...candidates)
    : parseIsoMs(cron.created_at);
  if (baseline === null) return { overdue: false };

  const s = (cron.schedule || '').trim();

  // Interval schedules ("6h", "30m"): a fixed period elapses between fires, so
  // overdue = the interval + grace has passed since the last fire.
  if (/^\d+[smhdw]$/i.test(s)) {
    const interval = scheduleIntervalMs(cron, nowMs);
    if (interval === null) return { overdue: false };
    if (nowMs - baseline > interval + GRACE_MS) {
      return {
        overdue: true,
        reason: `cron '${cron.name}' overdue by ${Math.round((nowMs - baseline - interval) / 60000)}m`,
      };
    }
    return { overdue: false };
  }

  // 5-field cron expressions: a cron is overdue ONLY if it missed its most recent
  // SCHEDULED slot — not merely "hasn't fired in 24h". The old flat-24h interval
  // flagged every cron firing less often than daily (weekly/monthly) as perpetually
  // overdue, which drove a false-positive restart storm. Derive the previous
  // scheduled slot from the schedule itself and check the last fire covered it.
  if (s.split(/\s+/).length === 5) {
    const next = nextFireFromCron(s, nowMs);
    if (!Number.isFinite(next)) return { overdue: false };
    const following = nextFireFromCron(s, next + 60_000);
    const period = Number.isFinite(following) ? following - next : 24 * 60 * 60_000;
    const prevSlot = next - period; // most recent scheduled fire time <= now (approx for irregular schedules)
    // Double grace absorbs schedule-boundary jitter so an on-time cron is never flagged.
    if (nowMs > prevSlot + GRACE_MS && baseline < prevSlot - GRACE_MS) {
      return {
        overdue: true,
        reason: `cron '${cron.name}' missed scheduled fire at ${new Date(prevSlot).toISOString()}`,
      };
    }
    return { overdue: false };
  }

  return { overdue: false };
}
