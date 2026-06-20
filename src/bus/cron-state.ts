/**
 * Daemon-side cron fire timestamp registry (cron-state.json).
 *
 * Solves the dead zone problem (issue #67): context compression silently drops
 * in-session CronCreate schedules. This module records when each named cron
 * last fired in a file that survives all restarts. AgentProcess polls the file
 * and injects a gap-nudge when a cron has been silent for >2x its interval.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus update-cron-fire <name> --interval <interval>`
 *      at the end of each cron prompt execution.
 *   2. Daemon gap-detection loop reads cron-state.json every 10 minutes.
 *   3. If last_fire is >2x interval ago, daemon injects a nudge into the agent PTY.
 *
 * Storage: state/<agent>/cron-state.json (same dir as pending-reminders.json).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

export interface CronFireRecord {
  name: string;
  last_fire: string;   // ISO 8601 UTC
  interval?: string;   // e.g. "6h", "24h", "30m" — copied from update call
}

interface CronStateFile {
  updated_at: string;
  crons: CronFireRecord[];
}

function cronStatePath(stateDir: string): string {
  return join(stateDir, 'cron-state.json');
}

export function readCronState(stateDir: string): CronStateFile {
  const filePath = cronStatePath(stateDir);
  if (!existsSync(filePath)) {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.crons)
      ? parsed
      : { updated_at: new Date().toISOString(), crons: [] };
  } catch {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
}

/**
 * Record that a cron just fired. Creates or updates the entry for `cronName`.
 * Called by agents via `cortextos bus update-cron-fire <name> --interval <interval>`.
 */
export function updateCronFire(
  stateDir: string,
  cronName: string,
  interval?: string,
): void {
  ensureDir(stateDir);
  const state = readCronState(stateDir);
  const now = new Date().toISOString();

  const idx = state.crons.findIndex(r => r.name === cronName);
  const record: CronFireRecord = { name: cronName, last_fire: now, ...(interval ? { interval } : {}) };

  if (idx === -1) {
    state.crons.push(record);
  } else {
    state.crons[idx] = record;
  }

  state.updated_at = now;
  writeFileSync(cronStatePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Default staleness floor for {@link pruneCronState}: an orphaned record (one
 * whose name is absent from the live cron set) is only pruned once its
 * `last_fire` is older than this. 14 days comfortably exceeds the firing
 * interval of every recurring cron in the fleet (the longest are weekly), so a
 * genuinely-live cron that is transiently missing from the live set — e.g.
 * config.json updated a beat before crons.json during a manage-cycle injection
 * — can never be deleted, because its fresh last_fire keeps it under the floor.
 */
export const DEFAULT_PRUNE_MIN_STALE_MS = 14 * 86_400_000; // 14 days

export interface PruneCronStateOptions {
  /**
   * Minimum age (ms) a record's `last_fire` must exceed before the record is
   * eligible for pruning. Records younger than this are retained even when
   * their name is absent from `liveCronNames`. Defaults to
   * {@link DEFAULT_PRUNE_MIN_STALE_MS}.
   */
  minStaleMs?: number;
}

/**
 * Remove orphaned entries from cron-state.json — records whose cron no longer
 * exists in the live cron set AND whose `last_fire` is older than the staleness
 * floor (see {@link DEFAULT_PRUNE_MIN_STALE_MS}).
 *
 * WHY THIS EXISTS (SYS-CRON-STATE-ORPHAN-PRUNE)
 * --------------------------------------------
 * {@link updateCronFire} only ever pushes/updates entries — it has no prune
 * path. When a cron is renamed or removed, its record persists forever with a
 * stale last_fire, which (1) accumulates unboundedly and (2) produces raw
 * drift-watchdog false-positives. This restores the missing prune path.
 *
 * SAFETY: the union-vs-staleness guard
 * ------------------------------------
 * Crons live in three stores (config.json boot source, daemon crons.json live
 * source, global manage-cycle cycle defs — see reference_fleet_cycle_cron_infra).
 * crons.json is the authoritative *firing* source: a cron only records to
 * cron-state.json via `bus update-cron-fire` at the end of a prompt the daemon
 * dispatched, and the daemon only dispatches crons present in crons.json. So
 * `liveCronNames` built from crons.json is sufficient in steady state. The
 * staleness floor is the belt-and-suspenders guard for the transient window
 * where a cron is being added/migrated and is momentarily in one store but not
 * crons.json: a live cron fires far more often than the floor, so recency alone
 * proves liveness regardless of which store currently lists it. Callers should
 * still pass the widest live set they can cheaply assemble.
 *
 * Pure no-op (no disk write) when nothing is pruned, so it is cheap to call on
 * every scheduler load/reload.
 *
 * @param stateDir       - state/<agent> directory holding cron-state.json.
 * @param liveCronNames  - Names of all currently-defined crons (enabled AND
 *                         disabled — a disabled cron is still live and keeps
 *                         its state). Should be the union of every known store.
 * @param opts           - Optional staleness floor override.
 * @returns the list of pruned cron names (empty if nothing was removed).
 */
export function pruneCronState(
  stateDir: string,
  liveCronNames: Iterable<string>,
  opts: PruneCronStateOptions = {},
): string[] {
  const minStaleMs = opts.minStaleMs ?? DEFAULT_PRUNE_MIN_STALE_MS;
  const live = liveCronNames instanceof Set ? liveCronNames : new Set(liveCronNames);
  const state = readCronState(stateDir);
  const now = Date.now();

  const pruned: string[] = [];
  const kept = state.crons.filter(rec => {
    if (live.has(rec.name)) return true; // still a live cron — always keep
    // Orphan candidate: only prune if demonstrably stale, so transient
    // store-skew on a genuinely-live cron can never delete its state.
    const fireMs = Date.parse(rec.last_fire);
    const ageMs = isNaN(fireMs) ? Infinity : now - fireMs;
    if (ageMs > minStaleMs) {
      pruned.push(rec.name);
      return false;
    }
    return true;
  });

  if (pruned.length === 0) return [];

  ensureDir(stateDir);
  writeFileSync(
    cronStatePath(stateDir),
    JSON.stringify({ updated_at: new Date(now).toISOString(), crons: kept }, null, 2) + '\n',
    'utf-8',
  );
  return pruned;
}

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Estimate the minimum expected firing interval for a 5-field cron expression.
 * Handles common patterns (every-N-minutes, every-N-hours, daily) without an
 * external library. Returns a conservative 48h fallback for anything else.
 */
export function cronExpressionMinIntervalMs(expr: string): number {
  const FALLBACK_MS = 48 * 3_600_000;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour] = parts;

  // Every N minutes: */N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;

  // Every N hours: <fixed-minute> */N * * *
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 3_600_000;

  // Fixed hour — fires daily (or on restricted days; 24h is the minimum gap)
  if (/^\d+$/.test(hour)) return 24 * 3_600_000;

  return FALLBACK_MS;
}
