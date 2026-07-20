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
 * Estimate the minimum expected firing interval for a 5-field cron expression.
 * Handles common patterns (every-N-minutes, every-N-hours, daily, weekly,
 * monthly, yearly) without an external library.
 * Returns a conservative 48h fallback for anything else.
 *
 * Defect 2 fix (2026-07-20): previously returned 24h for ANY fixed-hour
 * expression, including yearly patterns like "0 15 18 7 *". This caused the
 * catch-up staleness check to drop any miss older than 24h — meaning a cron
 * scheduled for a specific calendar date would be silently skipped if the
 * daemon was down for even 25 hours. Now inspects dom and month fields to
 * return the correct interval.
 */
export function cronExpressionMinIntervalMs(expr: string): number {
  const FALLBACK_MS = 48 * 3_600_000;
  const DAY_MS     = 24 * 3_600_000;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour, dom, month, dow] = parts;

  // Every N minutes: */N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;

  // Every N hours: <fixed-minute> */N * * *
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 3_600_000;

  // A field is "fixed" (not wildcard) when it has no * or / — i.e. it names
  // specific values only (single digit, comma-list, or range).
  const isFixed = (f: string) => !f.includes('*') && !f.includes('/');

  if (/^\d+$/.test(hour)) {
    // Fixed month AND dom: fires once per year (e.g. "0 15 18 7 *", "0 15 1 1,7 *")
    if (isFixed(month)) return 365 * DAY_MS;

    // Fixed dom, wildcard month: fires once per month (e.g. "0 9 1 * *")
    if (isFixed(dom)) return 30 * DAY_MS;

    // Fixed day-of-week: fires once per week (e.g. "0 9 * * 1")
    if (isFixed(dow)) return 7 * DAY_MS;

    // Fixed hour only: fires daily
    return DAY_MS;
  }

  return FALLBACK_MS;
}
