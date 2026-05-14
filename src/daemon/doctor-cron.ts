import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { runAllChecks, type Check } from '../utils/health-checks.js';
import { emitOperatorAlert } from './operator-alert.js';
import { logDaemonEvent } from './daemon-event-logger.js';

// ---------------------------------------------------------------------------
// Fleet-resilience plan #4 — daemon-side periodic doctor cron.
//
// On schedule (default every 30 min), runs the same `runAllChecks` registry
// that backs `cortextos doctor` and compares against the last-run snapshot
// at state/.doctor-last-run.json. Emits a CRITICAL operator alert when a
// check transitions:
//
//   pass → warn         baseline degraded
//   pass → fail         hard failure
//   warn → fail         escalation
//
// And an informational entry when:
//
//   warn → pass         recovered
//   fail → pass         recovered
//
// On the first run after a daemon start: surfaces a single summary of any
// currently-warn/fail checks (so an operator-restart against a broken host
// pages immediately instead of waiting for state to *change*).
//
// Subsequent unchanged runs are silent — this is the common case.
// ---------------------------------------------------------------------------

interface DoctorLastRun {
  ranAt: string;
  /** name → status map captured on the last run */
  checks: Record<string, Check['status']>;
}

export function doctorLastRunPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.doctor-last-run.json');
}

export function readLastRun(ctxRoot: string): DoctorLastRun | null {
  const p = doctorLastRunPath(ctxRoot);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as DoctorLastRun;
    if (typeof parsed?.ranAt !== 'string' || typeof parsed?.checks !== 'object' || parsed.checks === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLastRun(ctxRoot: string, snapshot: DoctorLastRun): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    atomicWriteSync(doctorLastRunPath(ctxRoot), JSON.stringify(snapshot, null, 2));
  } catch {
    console.error('[doctor-cron] Failed to persist last-run snapshot (non-fatal)');
  }
}

export interface DoctorCronDelta {
  newFailures: string[];   // pass→fail or warn→fail
  newWarnings: string[];   // pass→warn
  resolved: string[];      // warn|fail → pass
}

/**
 * Compute the delta between two check snapshots. Pure function — used by
 * the cron loop and by tests.
 */
export function computeDelta(
  current: Check[],
  previous: Record<string, Check['status']> | null,
): DoctorCronDelta {
  const delta: DoctorCronDelta = { newFailures: [], newWarnings: [], resolved: [] };
  for (const c of current) {
    const prev = previous?.[c.name];
    if (prev === undefined) {
      // Newly-introduced check or first run — see runOnce baseline path.
      continue;
    }
    if (prev === 'pass' && c.status === 'warn') delta.newWarnings.push(c.name);
    else if ((prev === 'pass' || prev === 'warn') && c.status === 'fail') delta.newFailures.push(c.name);
    else if ((prev === 'warn' || prev === 'fail') && c.status === 'pass') delta.resolved.push(c.name);
  }
  return delta;
}

function snapshotOf(checks: Check[]): Record<string, Check['status']> {
  const out: Record<string, Check['status']> = {};
  for (const c of checks) out[c.name] = c.status;
  return out;
}

export interface DoctorCronOptions {
  ctxRoot: string;
  /**
   * Repository root the checks probe — pass the daemon's `CTX_FRAMEWORK_ROOT`.
   * Note: the on-demand `cortextos doctor` CLI uses `process.cwd()` instead,
   * so the two callers may probe different trees if the CLI is run from a
   * directory other than the daemon's framework root. Intentional: the CLI
   * "diagnose where I am"; the cron "diagnose the daemon's fleet".
   */
  frameworkRoot: string;
  instanceId: string;
  /** Default 30 min. 0 disables. */
  intervalMinutes: number;
  /** Daemon's startup org. When present, doctor_delta_detected events fire as
   *  queryable JSONL under the `_daemon` synthetic agent identity. Optional so
   *  tests that don't exercise the wire stay simple. */
  org?: string;
  /** Override for tests. */
  logger?: (msg: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class DoctorCron {
  private readonly ctxRoot: string;
  private readonly frameworkRoot: string;
  private readonly instanceId: string;
  private readonly intervalMs: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;
  private readonly org?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: DoctorCronOptions) {
    this.ctxRoot = opts.ctxRoot;
    this.frameworkRoot = opts.frameworkRoot;
    this.instanceId = opts.instanceId;
    this.intervalMs = opts.intervalMinutes * 60_000;
    this.logger = opts.logger ?? ((m) => console.error(m));
    this.now = opts.now ?? Date.now;
    this.org = opts.org;
  }

  start(): void {
    if (this.timer !== null) return;
    if (this.intervalMs <= 0) {
      this.logger('[doctor-cron] disabled (intervalMinutes=0)');
      return;
    }
    // Fire one tick immediately so a daemon restart against a broken host
    // surfaces the current state without waiting `intervalMs`. The tick
    // is async; we don't await it here so start() stays non-blocking.
    // If shutdown happens during this window the initial tick still
    // completes and writes the snapshot — the cleared interval doesn't
    // cancel an already-in-flight runOnce.
    void this.runOnce().catch((err) => this.logger(`[doctor-cron] initial tick failed: ${err}`));
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.logger(`[doctor-cron] tick failed: ${err}`));
    }, this.intervalMs);
    // Don't keep Node alive solely on this interval — the daemon's IPC
    // server + agent timers do that. Lets tests using start() exit cleanly
    // if they forget to call stop() (the existing tests use runOnce() directly).
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the checks once, diff against the last snapshot, emit alerts on
   * delta, and persist the new snapshot. Exposed for tests + the initial
   * tick.
   */
  async runOnce(): Promise<{ checks: Check[]; delta: DoctorCronDelta; baselineEmitted: boolean }> {
    if (this.inFlight) {
      return { checks: [], delta: { newFailures: [], newWarnings: [], resolved: [] }, baselineEmitted: false };
    }
    this.inFlight = true;
    try {
      const checks = await runAllChecks({
        instanceId: this.instanceId,
        frameworkRoot: this.frameworkRoot,
      });
      const previous = readLastRun(this.ctxRoot);
      let baselineEmitted = false;
      let delta: DoctorCronDelta = { newFailures: [], newWarnings: [], resolved: [] };

      if (previous === null) {
        // First run after daemon start. Surface the current set of
        // warn/fail checks as a baseline so a restart against a broken
        // host pages immediately.
        const currentWarn = checks.filter((c) => c.status === 'warn').map((c) => c.name);
        const currentFail = checks.filter((c) => c.status === 'fail').map((c) => c.name);
        if (currentWarn.length > 0 || currentFail.length > 0) {
          this.emitAlert(currentFail, currentWarn, []);
          baselineEmitted = true;
        }
      } else {
        delta = computeDelta(checks, previous.checks);
        if (delta.newFailures.length > 0 || delta.newWarnings.length > 0 || delta.resolved.length > 0) {
          this.emitAlert(delta.newFailures, delta.newWarnings, delta.resolved);
        }
      }

      writeLastRun(this.ctxRoot, {
        ranAt: new Date(this.now()).toISOString(),
        checks: snapshotOf(checks),
      });

      return { checks, delta, baselineEmitted };
    } finally {
      this.inFlight = false;
    }
  }

  private emitAlert(failures: string[], warnings: string[], resolved: string[]): void {
    const lines: string[] = [`⚠️ Doctor: ${failures.length + warnings.length} new issue(s)`];
    for (const n of failures) lines.push(`  • ${n}: FAIL`);
    for (const n of warnings) lines.push(`  • ${n}: WARN`);
    if (resolved.length > 0) {
      lines.push(`Resolved: ${resolved.join(', ')}`);
    }
    lines.push('Run `cortextos doctor` for full output.');
    const text = lines.join('\n');

    emitOperatorAlert(this.ctxRoot, this.frameworkRoot, {
      kind: 'doctor_delta',
      severity: failures.length > 0 ? 'CRITICAL' : 'WARN',
      text,
      cooldownKey: 'doctor_delta',
      // The doctor-cron's own intervalMs already gates how often we even
      // *consider* emitting (once every 30 min). The delta logic ensures
      // unchanged runs are silent. Adding an operator-alert cooldown on top
      // would gate-block legitimate back-to-back transitions (e.g. fail
      // appears at t=0, recovers at t=interval), so disable the
      // operator-alert cooldown for this caller.
      cooldownMs: 0,
    });
    this.logger(
      `[doctor-cron] doctor_delta_detected new_failures=${failures.length} ` +
      `new_warnings=${warnings.length} resolved=${resolved.length}`,
    );
    if (this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'doctor_delta_detected',
        failures.length > 0 ? 'critical' : 'warning',
        { new_failures: failures, new_warnings: warnings, resolved },
      );
    }
  }
}
