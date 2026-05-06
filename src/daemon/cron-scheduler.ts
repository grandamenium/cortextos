/**
 * cron-scheduler.ts — Daemon Cron Scheduling Engine (Subtask 1.3).
 *
 * The CronScheduler class is instantiated once by the daemon and ticks every
 * 30 seconds.  On each tick it checks which external crons are due and calls
 * the caller-supplied `onFire` callback for each one.
 *
 * CATCH-UP POLICY
 * ---------------
 * If the daemon was stopped and a cron's computed nextFireAt is in the past
 * on start(), we fire ONCE for the most recent missed window, then advance
 * nextFireAt to the next future slot.  We deliberately do not flood-fire all
 * missed windows — one catch-up is enough to inform the agent that time has
 * passed, and the agent can decide whether further action is needed.
 *
 * RETRY POLICY
 * ------------
 * 3 attempts with exponential backoff (1s → 4s → 16s).  If all 3 fail the
 * error is logged and the scheduler moves on — it does NOT crash.
 *
 * RELOAD SEMANTICS
 * ----------------
 * reload() re-reads crons.json.  For crons whose name + schedule string are
 * unchanged the in-memory nextFireAt is preserved so we don't reset timers.
 * New or modified crons get a freshly computed nextFireAt.
 */

import { homedir } from 'os';
import { join } from 'path';
import { parseDurationMs, readCronState } from '../bus/cron-state.js';
import { readCronsWithStatus, updateCron } from '../bus/crons.js';
import type { CronDefinition } from '../types/index.js';
import { appendExecutionLog } from './cron-execution-log.js';

// ---------------------------------------------------------------------------
// Cron expression parser — no external deps.
// Supports: *, */N, comma-lists, and ranges for each of the 5 standard fields.
// Fields: minute hour dom month dow (day-of-week: 0=Sunday … 6=Saturday).
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field string into the set of matching integers.
 *
 * @param field - Raw field token (e.g. "*", "*\/5", "0,15,30,45", "1-5").
 * @param min   - Minimum valid value for this field (0 or 1).
 * @param max   - Maximum valid value (e.g. 59, 23, 31, 12, 6).
 */
function expandField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid cron range: ${part}`);
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid cron value: ${part}`);
      result.add(n);
    }
  }

  return [...result].sort((a, b) => a - b);
}

/**
 * Compute the next fire timestamp (ms since epoch) for a 5-field cron
 * expression, starting from `fromMs` (exclusive — the next fire must be
 * strictly after fromMs, rounded forward to the next whole minute).
 *
 * @param expr   - 5-field cron expression ("min hour dom month dow").
 * @param fromMs - Starting epoch time in milliseconds.
 * @returns      Epoch ms of the next matching minute, or NaN if unparseable.
 */
export function nextFireFromCron(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;

  let [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expandField(minuteStr, 0, 59);
    hours   = expandField(hourStr,   0, 23);
    doms    = expandField(domStr,    1, 31);
    months  = expandField(monthStr,  1, 12);
    dows    = expandField(dowStr,    0, 6);
  } catch {
    return NaN;
  }

  // Start from the next whole minute after fromMs
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;

  // Walk forward minute-by-minute (capped at 1 year to avoid infinite loops).
  const MAX_MINUTES = 366 * 24 * 60;
  let candidate = startMs;

  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(candidate);
    const m  = d.getMinutes();
    const h  = d.getHours();
    const dy = d.getDate();
    const mo = d.getMonth() + 1; // 1-12
    const dw = d.getDay();       // 0-6

    if (
      months.includes(mo) &&
      doms.includes(dy) &&
      dows.includes(dw) &&
      hours.includes(h) &&
      minutes.includes(m)
    ) {
      return candidate;
    }

    candidate += 60_000;
  }

  return NaN; // should never reach here for valid expressions
}

// ---------------------------------------------------------------------------
// Internal scheduler state for a single cron
// ---------------------------------------------------------------------------

interface ScheduledCron {
  definition: CronDefinition;
  /** Epoch ms when this cron should next fire. */
  nextFireAt: number;
  /** Normalised key for detecting definition changes: name|schedule */
  changeKey: string;
  /** True while onFire (+ retries) is executing — prevents re-entry on the next tick. */
  firing?: boolean;
}

function changeKeyFor(c: CronDefinition): string {
  return `${c.name}|${c.schedule}`;
}

/**
 * Compute the next fire time for a cron definition.
 *
 * For interval shorthands ("6h", "30m") we count forward from the
 * reference time.  For cron expressions we call nextFireFromCron().
 *
 * @param cron        - The cron definition.
 * @param referenceMs - Epoch ms to count forward from (usually now or lastFiredAt).
 */
function computeNextFireAt(cron: CronDefinition, referenceMs: number): number {
  const durationMs = parseDurationMs(cron.schedule);
  if (!isNaN(durationMs)) {
    return referenceMs + durationMs;
  }
  // Try as a cron expression
  const next = nextFireFromCron(cron.schedule, referenceMs);
  return next;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

async function fireWithRetry(
  cron: CronDefinition,
  agentName: string,
  onFire: (c: CronDefinition) => Promise<void> | void,
  logger: (msg: string) => void,
): Promise<boolean> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1; // 4 attempts total
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();
    try {
      await Promise.resolve(onFire(cron));
      appendExecutionLog(agentName, {
        ts: new Date().toISOString(),
        cron: cron.name,
        status: 'fired',
        attempt: attempt + 1,
        duration_ms: Date.now() - start,
        error: null,
      });
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const duration_ms = Date.now() - start;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `(attempt ${attempt + 1}/4, retrying in ${delay}ms): ${errMsg}`
        );
        appendExecutionLog(agentName, {
          ts: new Date().toISOString(),
          cron: cron.name,
          status: 'retried',
          attempt: attempt + 1,
          duration_ms,
          error: errMsg,
        });
        await sleep(delay);
      } else {
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `after all 4 attempts — giving up. Last error: ${errMsg}`
        );
        appendExecutionLog(agentName, {
          ts: new Date().toISOString(),
          cron: cron.name,
          status: 'failed',
          attempt: attempt + 1,
          duration_ms,
          error: errMsg,
        });
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export interface CronSchedulerOptions {
  agentName: string;
  onFire: (cron: CronDefinition) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export class CronScheduler {
  private readonly agentName: string;
  private readonly onFire: (cron: CronDefinition) => Promise<void> | void;
  private readonly logger: (msg: string) => void;

  /** In-memory schedule, keyed by cron name. */
  private scheduled: Map<string, ScheduledCron> = new Map();

  /**
   * Snapshot of the last successfully loaded non-empty schedule.
   *
   * Updated every time `loadCrons()` produces a non-empty result.  When a
   * subsequent reload produces an empty result (e.g. transient corruption),
   * the scheduler keeps firing the last-good schedule and logs a warning
   * instead of silently dropping all cron definitions.
   *
   * This snapshot is only held in memory — it does NOT persist across process
   * restarts (see PHASE5-FAILURE-MODES-REPORT.md for design rationale).
   */
  private lastGoodSchedule: Map<string, ScheduledCron> = new Map();

  /** The master 30-second interval handle. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Epoch ms of the tick interval, exposed so tests can override. */
  static readonly TICK_INTERVAL_MS = 30_000;

  constructor(opts: CronSchedulerOptions) {
    this.agentName = opts.agentName;
    this.onFire    = opts.onFire;
    this.logger    = opts.logger ?? ((msg: string) => process.stdout.write(msg + '\n'));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the scheduler.  Reads crons.json, builds in-memory schedule, and
   * begins the master tick loop.
   */
  start(): void {
    if (this.tickHandle !== null) {
      this.logger('[cron-scheduler] start() called while already running — ignored');
      return;
    }
    this.loadCrons(/* isReload */ false);
    this.tickHandle = setInterval(() => void this.tick(), CronScheduler.TICK_INTERVAL_MS);
    this.logger(`[cron-scheduler] started for agent "${this.agentName}" with ${this.scheduled.size} cron(s)`);
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.scheduled.clear();
    this.logger(`[cron-scheduler] stopped for agent "${this.agentName}"`);
  }

  /**
   * Re-read crons.json and update the in-memory schedule.
   *
   * Crons whose name + schedule are unchanged retain their current nextFireAt
   * so we don't accidentally reset pending timers.  New or modified crons get
   * a freshly computed nextFireAt.
   */
  reload(): void {
    this.loadCrons(/* isReload */ true);
    this.logger(`[cron-scheduler] reloaded for agent "${this.agentName}" — ${this.scheduled.size} cron(s) active`);
  }

  /**
   * Return the next fire time for every scheduled cron (for CLI/debugging).
   */
  getNextFireTimes(): Array<{ name: string; nextFireAt: number }> {
    return [...this.scheduled.values()].map(sc => ({
      name: sc.definition.name,
      nextFireAt: sc.nextFireAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private loadCrons(isReload: boolean): void {
    const now = Date.now();
    const { crons: defs, corrupt } = readCronsWithStatus(this.agentName);
    const nextScheduled = new Map<string, ScheduledCron>();

    // Read cron-state.json so catch-up sees fires recorded by `bus update-cron-fire`
    // (e.g. agent heartbeat skills). Without this, a cron that pre-dates the
    // external-cron migration shows last_fire only in cron-state.json — the
    // scheduler would otherwise compute referenceMs=now and skip catch-up,
    // silently dropping the overdue fire.
    //
    // Resolve stateDir from CTX_ROOT so test sandboxes (which override CTX_ROOT
    // but not homedir) don't accidentally read production state.
    const ctxRoot = process.env.CTX_ROOT ||
      join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
    const stateDir = join(ctxRoot, 'state', this.agentName);
    let stateLastFireByName = new Map<string, string>();
    try {
      const stateFile = readCronState(stateDir);
      for (const rec of stateFile.crons) stateLastFireByName.set(rec.name, rec.last_fire);
    } catch {
      // Malformed file / missing dir — fall back to crons.json only
    }

    for (const def of defs) {
      if (!def.enabled) {
        // Disabled — silently skip
        continue;
      }

      const key = changeKeyFor(def);
      const existing = this.scheduled.get(def.name);

      if (isReload && existing !== undefined && existing.changeKey === key) {
        // Definition unchanged — preserve nextFireAt
        nextScheduled.set(def.name, { ...existing, definition: def });
        continue;
      }

      // RELOAD-WHILE-FIRING GUARD: if the cron is mid-fire, preserve the
      // existing entry as-is until the fire completes.  A fresh ScheduledCron
      // built from stale crons.json (last_fired_at not yet persisted) would
      // catch-up-fire on the next tick and double-fire the same logical event.
      // The next reload (manual or after fire completes) will pick up the
      // new schedule cleanly.
      if (isReload && existing !== undefined && existing.firing === true) {
        this.logger(
          `[cron-scheduler] reload deferred for "${def.name}" — fire in progress; ` +
          `new schedule will apply on next reload after fire completes`
        );
        nextScheduled.set(def.name, existing);
        continue;
      }

      // New or modified cron — compute fresh nextFireAt.
      // Base: take the most recent of crons.json.last_fired_at,
      // crons.json.last_fire_attempted_at (set pre-onFire to detect crash
      // mid-fire — iter 11), and cron-state.json.last_fire (either may be
      // more current depending on which write path recorded the fire).
      // Fall back to now.
      const stateFire = stateLastFireByName.get(def.name);
      const candidates: number[] = [];
      if (def.last_fired_at) candidates.push(new Date(def.last_fired_at).getTime());
      if (def.last_fire_attempted_at) candidates.push(new Date(def.last_fire_attempted_at).getTime());
      if (stateFire) candidates.push(new Date(stateFire).getTime());
      const referenceMs = candidates.length > 0 ? Math.max(...candidates) : now;

      let nextFireAt = computeNextFireAt(def, referenceMs);

      if (isNaN(nextFireAt)) {
        this.logger(
          `[cron-scheduler] WARNING: cannot parse schedule "${def.schedule}" for cron "${def.name}" — skipping`
        );
        continue;
      }

      // CATCH-UP POLICY: if nextFireAt is in the past (daemon was stopped),
      // fire once immediately for the missed window, then recompute from now.
      // We do NOT flood-fire all missed windows — one catch-up is sufficient.
      if (nextFireAt <= now) {
        this.logger(
          `[cron-scheduler] catch-up: cron "${def.name}" missed fire at ${new Date(nextFireAt).toISOString()} — scheduling immediate fire`
        );
        nextFireAt = now; // fire on the very next tick
      }

      nextScheduled.set(def.name, { definition: def, nextFireAt, changeKey: key });
    }

    // LAST-GOOD-SCHEDULE FALLBACK (corruption-only)
    // If this is a reload AND readCronsWithStatus reported `corrupt: true`
    // (primary file unparseable AND .bak fallback failed/missing), retain
    // the previous in-memory schedule instead of silently dropping all cron
    // definitions.  This prevents transient corruption from halting cron
    // execution on a running scheduler.
    //
    // CRITICAL: we ONLY apply this fallback when `corrupt === true`.  An empty
    // result with `corrupt === false` is a legitimate empty file — produced
    // by `bus remove-cron` on the last cron, or a freshly initialized agent —
    // and the schedule MUST be cleared.  Earlier versions of this method
    // gated only on `nextScheduled.size === 0`, which restored the just-removed
    // cron from `lastGoodSchedule` and kept firing it after removal until the
    // daemon restarted (iter 9 regression).
    //
    // We do NOT apply this fallback on initial start() — an empty/missing file
    // on startup is normal and should produce an empty schedule.
    if (isReload && corrupt && nextScheduled.size === 0 && this.lastGoodSchedule.size > 0) {
      this.logger(
        `[cron-scheduler] WARNING: reload produced empty schedule for agent "${this.agentName}" — ` +
        `retaining last-good schedule (${this.lastGoodSchedule.size} cron(s)) until file is repaired`
      );
      this.scheduled = new Map(this.lastGoodSchedule);
      return;
    }

    this.scheduled = nextScheduled;

    // Update the last-good snapshot whenever we get a non-empty result.
    if (nextScheduled.size > 0) {
      this.lastGoodSchedule = new Map(nextScheduled);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const [name, sc] of this.scheduled) {
      if (sc.nextFireAt > now) {
        continue; // not yet due
      }

      // Guard against re-entry: if a previous tick's async fire+retry is still
      // in flight (can happen with fake timers or very slow onFire), skip.
      if (sc.firing) {
        continue;
      }

      sc.firing = true;
      const cron = sc.definition;
      this.logger(`[cron-scheduler] firing cron "${name}" (was due ${new Date(sc.nextFireAt).toISOString()})`);

      // Persist last_fire_attempted_at to disk BEFORE awaiting the dispatch.
      // If the daemon crashes between this point and the post-success
      // updateCron below, loadCrons() on restart will see this attempt
      // timestamp in the referenceMs candidates and avoid re-firing the
      // same slot via the catch-up gate. (See iter 10/11 audit.)
      const attemptIso = new Date(now).toISOString();
      try {
        updateCron(this.agentName, name, { last_fire_attempted_at: attemptIso });
        sc.definition = { ...cron, last_fire_attempted_at: attemptIso };
      } catch (err) {
        this.logger(
          `[cron-scheduler] WARNING: failed to persist last_fire_attempted_at for "${name}" — ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Continuing dispatch; crash mid-fire could double-fire on restart.`
        );
      }

      const success = await fireWithRetry(cron, this.agentName, this.onFire, this.logger);

      if (success) {
        // Persist last_fired_at + fire_count to disk.
        // updateCron writes through atomicWriteSync and can throw ENOSPC or
        // EACCES (disk full / read-only filesystem).  These errors must not
        // crash the tick loop — we log and keep the in-memory schedule intact.
        const nowIso = new Date(now).toISOString();
        const newFireCount = (cron.fire_count ?? 0) + 1;
        try {
          updateCron(this.agentName, name, {
            last_fired_at: nowIso,
            fire_count: newFireCount,
          });
        } catch (err) {
          this.logger(
            `[cron-scheduler] WARNING: failed to persist fire state for "${name}" — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `In-memory schedule retained; state will be lost if daemon restarts.`
          );
        }

        // Advance in-memory nextFireAt
        const next = computeNextFireAt(cron, now);
        if (!isNaN(next)) {
          sc.nextFireAt = next;
          sc.definition = { ...cron, last_fired_at: nowIso, fire_count: newFireCount };
        } else {
          // Unrecognised schedule after fire — remove from schedule to avoid infinite loops
          this.scheduled.delete(name);
          this.logger(`[cron-scheduler] WARNING: removed "${name}" from schedule after fire — schedule unparseable`);
          continue; // sc is gone, skip clearing firing flag
        }
      } else {
        // Dispatch failed (all retries exhausted). Advance nextFireAt anyway so
        // we don't re-fire the same scheduled slot on every subsequent tick —
        // that produced a busy-loop when an agent was unreachable. Treat the
        // failed window as a missed slot and schedule the next normal fire.
        const next = computeNextFireAt(cron, now);
        if (!isNaN(next)) {
          sc.nextFireAt = next;
          this.logger(
            `[cron-scheduler] WARNING: "${name}" dispatch failed — advancing to next slot ${new Date(next).toISOString()} ` +
            `to avoid busy-loop (no last_fired_at update; failure recorded in execution log)`
          );
        } else {
          this.scheduled.delete(name);
          this.logger(`[cron-scheduler] WARNING: removed "${name}" from schedule after failure — schedule unparseable`);
          continue;
        }
      }
      sc.firing = false;
    }
  }
}
