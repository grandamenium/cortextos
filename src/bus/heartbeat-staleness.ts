/**
 * Per-agent heartbeat-staleness thresholds (Finding F).
 *
 * The fleet-health watchdog used a FLAT 5h threshold, so an agent dead 3.5h read
 * "healthy" (paul, 01:00Z) — a flat threshold can't tell a 5-min-cadence agent
 * (dead at 30m) from a 4h-cadence agent (fine at 3h). The agent's heartbeat
 * record already carries `loop_interval` (its expected cadence); derive the
 * threshold from it.
 */
import { parseDurationMs } from './cron-state.js';

export const HB_STALE_MULTIPLIER = 3;                       // stale at 3× the expected cadence …
export const HB_STALE_MIN_MS = 15 * 60 * 1000;             // … but never less than 15m,
export const HB_STALE_MAX_MS = 6 * 60 * 60 * 1000;         // … and never more than 6h,
export const HB_STALE_CADENCE_FLOOR_MULT = 1.5;            // … except a cadence ≥ the cap is not flagged
                                                           //     before 1.5× its own beat (cap-bite guard).
export const HB_STALE_FALLBACK_MS = 2 * 60 * 60 * 1000;    // 2h when loop_interval is missing/unparseable.

export interface StaleThreshold {
  thresholdMs: number;
  /** True when loop_interval was missing/unparseable and the fallback was used. */
  fallback: boolean;
}

/**
 * Compute the per-agent staleness threshold from the expected heartbeat cadence.
 *
 *   threshold = max( min(3×interval, 6h), 1.5×interval, 15m )
 *
 * The `1.5×interval` floor is the CAP-BITE GUARD: without it a cadence at/above
 * the 6h cap (e.g. a 6h heartbeat cron) would be flagged stale at exactly its
 * normal beat. With it, a 4h cadence stays 6h while a 6h cadence gets 9h.
 * Missing/unparseable interval → conservative 2h fallback (caller should log it).
 */
export function computeStaleThresholdMs(loopInterval: string | undefined | null): StaleThreshold {
  const ms = loopInterval ? parseDurationMs(loopInterval) : NaN;
  if (!loopInterval || !Number.isFinite(ms) || ms <= 0) {
    return { thresholdMs: HB_STALE_FALLBACK_MS, fallback: true };
  }
  const thresholdMs = Math.max(
    Math.min(HB_STALE_MULTIPLIER * ms, HB_STALE_MAX_MS),
    HB_STALE_CADENCE_FLOOR_MULT * ms,
    HB_STALE_MIN_MS,
  );
  return { thresholdMs, fallback: false };
}

/** True if the last heartbeat is older than the agent's per-cadence threshold. */
export function isHeartbeatStale(
  lastHeartbeatIso: string,
  loopInterval: string | undefined | null,
  now: number = Date.now(),
): boolean {
  const t = new Date(lastHeartbeatIso).getTime();
  if (!Number.isFinite(t)) return true; // unparseable timestamp → treat as stale
  return now - t > computeStaleThresholdMs(loopInterval).thresholdMs;
}
