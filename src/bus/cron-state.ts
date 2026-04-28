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
 * Estimate the maximum expected gap between consecutive fires for a 5-field
 * cron expression. The gap-detector multiplies this by 2 to derive its nudge
 * threshold, so the value must reflect the worst-case real-world gap — not
 * the typical case — or restricted crons get false-positive nudges.
 *
 * Coverage (using "[/]" to denote the cron step operator without confusing
 * this JSDoc block):
 *   - every-N-minutes:           "[/]N * * * *"          → N min
 *   - every-N-hours:             "<m> [/]N * * *"        → N h
 *   - daily fixed-hour:          "<m> <h> * * *"         → 24 h
 *   - day-of-week restricted:    "<m> <h> * * <dow>"     → max gap between
 *                                                          active weekdays
 *                                                          (1-5 → 72 h,
 *                                                          Sun-only → 168 h)
 *   - day-of-month every N:      "<m> <h> [/]N * *"      → N d
 *   - day-of-month fixed:        "<m> <h> <D> * *"       → 31 d (monthly)
 *   - month + day-of-month:      "<m> <h> <D> <M> *"     → 365 d (yearly)
 *   - month-only restriction:    "<m> <h> * <M> *"       → 365 d
 *   - anything else (lists,                              → 31 d fallback
 *     mixed restrictions)                                  (safer over-estimate;
 *                                                          only double-fires
 *                                                          would false-positive,
 *                                                          never missed crons)
 *
 * Returning the max gap (rather than the typical fire frequency) is correct
 * for gap-detection: the nudge fires on dead zones, not on rate.
 */
export function cronExpressionMinIntervalMs(expr: string): number {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const FALLBACK_MS = 31 * DAY;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour, dom, month, dow] = parts;

  const monthRestricted = month !== '*';
  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';

  // Every-N-minutes (no other restrictions): */N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*' && !domRestricted && !monthRestricted && !dowRestricted) {
    return parseInt(everyMin[1], 10) * MIN;
  }

  // Every-N-hours (no date-level restrictions): <m> */N * * *
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour && !domRestricted && !monthRestricted && !dowRestricted) {
    return parseInt(everyHour[1], 10) * HOUR;
  }

  // Specific month + specific day-of-month → fires once per matching combo,
  // worst case is yearly (one month per year × one day per month).
  if (monthRestricted && domRestricted) return 365 * DAY;

  // Specific day-of-month, any month → max gap is the longest month (31d),
  // or N days when given as */N.
  if (domRestricted) {
    const everyDom = /^\*\/(\d+)$/.exec(dom);
    if (everyDom) return parseInt(everyDom[1], 10) * DAY;
    return 31 * DAY;
  }

  // Specific months, any day → daily within those months but max gap
  // spans the unselected months. Conservatively yearly.
  if (monthRestricted) return 365 * DAY;

  // Day-of-week restricted (no DoM/Mon restrictions) — max gap is the
  // longest stretch between active weekdays.
  if (dowRestricted) {
    const maxGapDays = computeDayOfWeekMaxGap(dow);
    return maxGapDays * DAY;
  }

  // Fixed hour, no date restrictions → daily.
  if (/^\d+$/.test(hour)) return 24 * HOUR;

  return FALLBACK_MS;
}

/**
 * For a day-of-week field — single number, range ("1-5"), comma list
 * ("1,3,5"), or step expression — return the maximum number of days
 * between two consecutive active weekdays (cyclic across the week
 * boundary). Returns 7 on any unparseable shape; 7 is the worst-case
 * for any DoW restriction so it's a safe fallback.
 */
function computeDayOfWeekMaxGap(dow: string): number {
  const days = new Set<number>();

  for (const part of dow.split(',')) {
    const everyN = /^\*\/(\d+)$/.exec(part);
    if (everyN) {
      const step = parseInt(everyN[1], 10);
      if (step <= 0) return 7;
      for (let i = 0; i < 7; i += step) days.add(i);
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (a > b) return 7;
      for (let i = a; i <= b; i++) days.add(i % 7);
      continue;
    }
    if (/^\d+$/.test(part)) {
      days.add(parseInt(part, 10) % 7);
      continue;
    }
    return 7;
  }

  if (days.size === 0) return 7;

  const sorted = [...days].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 7;
    const gap = next - sorted[i];
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}
