/**
 * Single source of truth for "is this agent's heartbeat stale?".
 *
 * Previously TWO call sites hardcoded DIFFERENT thresholds — the CLI display
 * (src/cli/bus.ts) flagged STALE at 2h, the metrics counter (src/bus/metrics.ts)
 * counted healthy until 5h. They disagreed, so any agent on an interval between
 * 2h and 5h displayed STALE for part of every cycle while simultaneously being
 * counted healthy — two monitors, same agent, same instant, opposite verdicts.
 *
 * The fix is not "make the two constants match" — that just drifts apart again
 * the next time one is edited. It is ONE helper both sites call, and staleness
 * DERIVED from the agent's own configured heartbeat cadence (its `loop_interval`,
 * populated from its heartbeat cron), not a fleet-wide magic number.
 */
import { parseDurationMs } from './cron-state';

/** Fallback cadence when an agent's loop_interval isn't recorded — the standard
 *  heartbeat cron interval in this fleet. Only used when we can't do better. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

/** Never call an agent stale sooner than this, however short its interval, so a
 *  tick landing a little late doesn't flap the flag. */
export const MIN_STALE_MS = 60 * 60 * 1000; // 1h

/**
 * How old a heartbeat may get before it is stale: two missed cycles of the
 * agent's OWN interval (with a 1h floor). A 4h-interval agent is stale only past
 * 8h — so it is never flagged mid-cycle; a 27m-tick agent is stale past ~1h.
 */
export function heartbeatStaleThresholdMs(loopInterval?: string | null): number {
  const parsed = loopInterval ? parseDurationMs(loopInterval) : NaN;
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.max(base * 2, MIN_STALE_MS);
}

/**
 * True if the heartbeat is stale for an agent whose refresh cadence is
 * `loopInterval`. Missing/unparseable timestamps are treated as stale (fail
 * toward "not confirmed alive", the safe direction for a liveness check).
 */
export function isHeartbeatStale(
  lastHeartbeat: string | null | undefined,
  loopInterval?: string | null,
  now: number = Date.now(),
): boolean {
  if (!lastHeartbeat) return true;
  const t = new Date(lastHeartbeat).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > heartbeatStaleThresholdMs(loopInterval);
}
