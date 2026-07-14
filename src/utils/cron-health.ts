/**
 * cron-health.ts — Pure health computation helper for the fleet health dashboard.
 *
 * Subtask 4.4.
 *
 * This module is intentionally side-effect-free and has no I/O dependencies so
 * it can be unit-tested exhaustively with injected fixtures.
 *
 * States
 * ------
 *   never-fired  — cron has never produced an execution log entry (lastFire null)
 *                  AND it is not a future-scheduled one-shot in its grace window.
 *   failure      — most recent execution log entry is 'failed' with no later success.
 *   warning      — EITHER the cron missed a scheduled fire (cron-expression schedules,
 *                  detected within MISSED_FIRE_GRACE_MS of the slot — latency does NOT
 *                  scale with the cron's period), OR gap > 2 × expectedIntervalMs
 *                  (duration schedules, e.g. "4h").
 *   healthy      — everything else.
 *
 * One-shot crons (fire_at field set, no schedule interval)
 * ---------------------------------------------------------
 *   A "once" cron that has not yet fired but whose fire_at is still in the future
 *   (+ grace period) is treated as healthy — it is not overdue.
 *   After fire_at + grace period passes without a fire, it becomes warning/never-fired.
 */

import { parseDurationMs } from '../bus/cron-state.js';
import { nextFireFromCron } from '../daemon/cron-scheduler.js';
import type { CronSummaryRow, CronExecutionLogEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealth {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to. */
  org: string;
  /** Name of the cron. */
  cronName: string;
  /** Computed health state. */
  state: HealthState;
  /** Human-readable explanation, e.g. "last fire 3h ago, expected within 90m". */
  reason: string;
  /** Unix ms of the most recent fire attempt; null if never fired. */
  lastFire: number | null;
  /** Expected interval in ms (derived from schedule); 0 if not parseable (cron expr). */
  expectedIntervalMs: number;
  /** Gap (now - lastFire) in ms; null if never fired. */
  gapMs: number | null;
  /** Fraction of fires in the last 24h that succeeded (0–1). 1.0 if no fires. */
  successRate24h: number;
  /** Raw count of fire attempts in the last 24h. */
  firesLast24h: number;
  /** ISO string of nextFire from the CronSummaryRow. */
  nextFire: string;
}

// Per-agent summary used by the fleet-health IPC response.
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResult {
  rows: CronHealth[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiplier: a cron is "warning" when gap > WARNING_MULTIPLIER × expectedIntervalMs */
export const WARNING_MULTIPLIER = 2;

/**
 * Grace period after a scheduled slot before a missing fire is called a miss.
 * Absorbs normal execution latency (the agent records the fire a beat after the
 * scheduler triggers it) without letting a genuinely dead cron hide.
 */
export const MISSED_FIRE_GRACE_MS = 15 * 60_000;

/** Iteration cap when walking a cron expression forward. Bounds a pathological expr. */
const MAX_SLOT_WALK = 2_000;

/**
 * The most recent scheduled slot at or before `nowMs` for a 5-field cron expression.
 * Returns null if the expression is unparseable or has no slot in the lookback window.
 *
 * WHY THIS EXISTS — the bug it fixes:
 * expectedIntervalMs is derived via parseDurationMs(schedule), which returns NaN for a
 * CRON EXPRESSION ("7 15 * * 1"). NaN || 0 => 0, and the staleness rule is gated on
 * `expectedIntervalMs > 0` — so for every cron-expression cron THE WARNING BRANCH WAS
 * NEVER ENTERED. Not "warned late": NEVER WARNED. A cron dead for 30 days reported
 * HEALTHY. That was 13 of 24 fleet crons, including a weekly security sweep, a live-site
 * uptime check, and — the sharp one — the stale-heartbeat-check that exists to catch dead
 * agents and was itself unwatched.
 *
 * And the fix is NOT to teach parseDurationMs about cron expressions: that would arm the
 * 2x-gap rule, whose blind window SCALES WITH THE PERIOD (a weekly cron would still be
 * invisible for a fortnight). Gap-since-last-fire is the wrong primitive.
 *
 * The right question is not "how long since it last ran?" but "DID IT RUN WHEN IT SAID IT
 * WOULD?" — and the schedule already tells us when that was. Detection latency then tracks
 * the GRACE PERIOD, not the cron's cadence: a weekly sweep that skips its slot is caught in
 * minutes, exactly like a 27-minute tick.
 */
export function previousSlotMs(schedule: string, nowMs: number): number | null {
  // Look back far enough to contain at least one slot of any sane schedule (>1 week),
  // but walk forward from the *smallest* window that yields one so a per-minute cron
  // does not cost 10k iterations.
  for (const windowMs of [2 * 3_600_000, 26 * 3_600_000, 9 * 86_400_000]) {
    let cursor = nowMs - windowMs;
    let last: number | null = null;
    for (let i = 0; i < MAX_SLOT_WALK; i++) {
      const next = nextFireFromCron(schedule, cursor);
      if (Number.isNaN(next) || next > nowMs) break;
      last = next;
      cursor = next;
    }
    if (last !== null) return last;
  }
  return null;
}

/** Grace period for one-shot crons (ms): 10 minutes past fire_at before becoming warning */
const ONCE_GRACE_MS = 10 * 60 * 1000;

const MS_24H = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Compute health for a single cron given its summary row and recent executions.
 *
 * @param row               - CronSummaryRow from list-all-crons / listAllCrons().
 * @param executionsLast24h - All execution log entries for this cron in the last 24h.
 *                            Caller is responsible for pre-filtering to the cron + time window.
 * @param nowMs             - Epoch ms for "now" (injectable for deterministic tests).
 */
export function computeHealth(
  row: CronSummaryRow,
  executionsLast24h: CronExecutionLogEntry[],
  nowMs = Date.now(),
): CronHealth {
  const { agent, org, cron, lastFire: lastFireTs, lastStatus, nextFire } = row;

  // ── Derived timing values ──────────────────────────────────────────────────

  const lastFireMs: number | null = lastFireTs ? new Date(lastFireTs).getTime() : null;
  const gapMs: number | null = lastFireMs !== null ? nowMs - lastFireMs : null;

  // Expected interval: derive from schedule.
  // parseDurationMs returns NaN for cron expressions — treat those as 0 (unknown).
  const expectedIntervalMs = Math.max(0, parseDurationMs(cron.schedule) || 0);

  // ── 24h metrics ───────────────────────────────────────────────────────────

  const firesLast24h = executionsLast24h.length;
  const successCount = executionsLast24h.filter(e => e.status === 'fired').length;
  const successRate24h = firesLast24h > 0 ? successCount / firesLast24h : 1;

  // ── State machine ─────────────────────────────────────────────────────────

  // Check for one-shot cron that hasn't fired yet but is scheduled in the future
  if (lastFireMs === null && cron.fire_at) {
    const fireAtMs = new Date(cron.fire_at).getTime();
    if (!isNaN(fireAtMs)) {
      if (nowMs < fireAtMs + ONCE_GRACE_MS) {
        // Still within grace window — healthy
        return makeHealth(agent, org, cron.name, nextFire, 'healthy',
          `one-shot scheduled in the future (fire_at: ${cron.fire_at})`,
          lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
      }
      // Past grace window, never fired — fall through to never-fired
    }
  }

  // never-fired: no execution log entry at all
  if (lastFireMs === null) {
    return makeHealth(agent, org, cron.name, nextFire, 'never-fired',
      'cron has never fired — no execution history',
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // failure: most recent status is 'failed' AND no later success in log
  if (lastStatus === 'failed') {
    return makeHealth(agent, org, cron.name, nextFire, 'failure',
      `most recent execution failed (${formatRelativeMs(gapMs!)} ago)`,
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // warning: MISSED AN EXPECTED FIRE.
  //
  // This is the rule that covers cron-expression schedules, for which expectedIntervalMs
  // is 0 and the 2x-gap rule below is skipped entirely. It asks the right question — "did
  // it run when it said it would?" — so its detection latency is the grace period, NOT the
  // cron's period. A weekly cron is caught as fast as a 27-minute one.
  if (expectedIntervalMs === 0) {
    const slot = previousSlotMs(cron.schedule, nowMs);
    if (slot !== null && nowMs > slot + MISSED_FIRE_GRACE_MS) {
      // A fire recorded at/after the slot (minus a minute of clock slop) means it ran.
      const ranForSlot = lastFireMs !== null && lastFireMs >= slot - 60_000;
      if (!ranForSlot) {
        return makeHealth(agent, org, cron.name, nextFire, 'warning',
          `MISSED its scheduled fire at ${new Date(slot).toISOString()} ` +
          `(last fire ${lastFireMs === null ? 'never' : formatRelativeMs(gapMs!) + ' ago'})`,
          lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
      }
    }
  }

  // warning: gap > 2x expected interval (only applies when interval is known)
  if (expectedIntervalMs > 0 && gapMs !== null && gapMs > WARNING_MULTIPLIER * expectedIntervalMs) {
    const expectedLabel = formatMs(expectedIntervalMs);
    const gapLabel = formatMs(gapMs);
    return makeHealth(agent, org, cron.name, nextFire, 'warning',
      `last fire ${gapLabel} ago, expected within ${expectedLabel} (2x threshold exceeded)`,
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // healthy
  const gapLabel = gapMs !== null ? `${formatRelativeMs(gapMs)} ago` : 'never';
  return makeHealth(agent, org, cron.name, nextFire, 'healthy',
    `last fired ${gapLabel}`,
    lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
}

// ---------------------------------------------------------------------------
// Fleet aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate an array of CronHealth rows into a FleetHealthResult.
 * Pure — no I/O.
 */
export function aggregateFleetHealth(rows: CronHealth[]): FleetHealthResult {
  const summary = {
    total: rows.length,
    healthy: 0,
    warning: 0,
    failure: 0,
    neverFired: 0,
    agents: {} as Record<string, AgentHealthSummary>,
  };

  for (const row of rows) {
    // Top-level counters
    switch (row.state) {
      case 'healthy':    summary.healthy++;    break;
      case 'warning':    summary.warning++;    break;
      case 'failure':    summary.failure++;    break;
      case 'never-fired': summary.neverFired++; break;
    }

    // Per-agent breakdown
    if (!summary.agents[row.agent]) {
      summary.agents[row.agent] = {
        agent: row.agent,
        org: row.org,
        total: 0,
        healthy: 0,
        warning: 0,
        failure: 0,
        neverFired: 0,
      };
    }
    const agentSummary = summary.agents[row.agent];
    agentSummary.total++;
    switch (row.state) {
      case 'healthy':    agentSummary.healthy++;    break;
      case 'warning':    agentSummary.warning++;    break;
      case 'failure':    agentSummary.failure++;    break;
      case 'never-fired': agentSummary.neverFired++; break;
    }
  }

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeHealth(
  agent: string,
  org: string,
  cronName: string,
  nextFire: string,
  state: HealthState,
  reason: string,
  lastFire: number | null,
  expectedIntervalMs: number,
  gapMs: number | null,
  successRate24h: number,
  firesLast24h: number,
): CronHealth {
  return {
    agent,
    org,
    cronName,
    state,
    reason,
    lastFire,
    expectedIntervalMs,
    gapMs,
    successRate24h,
    firesLast24h,
    nextFire,
  };
}

/** Format a duration in ms as a compact human string: "3h", "45m", "2d". */
function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

/** Format a positive gap in ms as "3h 12m" style. */
function formatRelativeMs(ms: number): string {
  if (ms >= 86_400_000) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}
