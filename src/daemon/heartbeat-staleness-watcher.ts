import { createHash } from 'crypto';
import { readHeartbeatStatus } from '../utils/agent-status.js';
import { emitOperatorAlert } from './operator-alert.js';
import { logDaemonEvent } from './daemon-event-logger.js';

/** 8-char hash of an arbitrary string — used to keep per-task cooldown keys
 * filesystem-safe (task names may contain spaces, slashes, special chars). */
function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Fleet-resilience plan #2 — daemon-side heartbeat-staleness watchdog.
//
// Catches the "PTY alive but Claude wedged inside a tool call" class that no
// other recovery surface sees. The agent's heartbeat.json contains
// `last_heartbeat: ISO8601` and `current_task`. Every event-log write also
// refreshes last_heartbeat (see src/bus/event.ts:refreshHeartbeatTimestamp),
// so as long as the agent is doing *anything* observable the file ticks.
// Trap: user-facing bus commands like `send-telegram` and `send-message`
// also tick the heartbeat — they emit `telegram_sent` / `message_sent`
// events internally (see src/cli/bus.ts), so any timing test that depends
// on a "silent" agent must avoid those commands too, not only the obvious
// `update-heartbeat` and `log-event` surfaces.
// When it goes silent past `thresholdMs` the watcher escalates.
//
// Idle-suppression: a "stale" agent with `current_task === ''` is on standby
// by design — not hung. Standby agents only tick when their (typically 4h)
// heartbeat cron fires, so any tighter threshold treats them as stale 99% of
// the time. The watcher therefore alerts only when current_task is non-empty
// (i.e. the agent is supposed to be active and observable). Suppressions emit
// a `heartbeat_idle_suppressed` daemon event so analyst can still see the
// quiet agents in metrics, but do not page the operator.
//
// Each agent owns one watcher (constructed by AgentManager.startAgent and
// stopped in AgentManager.stopAgent). Per-agent ownership keeps lifecycle
// piggybacked on existing teardown paths rather than threading a fleet-wide
// state map.
//
// Cold-boot handling: the watcher arms ONLY after observing the first
// successful heartbeat read. A freshly-spawned agent that hasn't written
// heartbeat.json yet should not pager — that's a startup race, not staleness.
//
// Mid-write tolerance: two consecutive failed reads required before flagging
// stale. atomicWriteSync's tmp→rename window is microseconds, but the
// watcher's poll cadence is seconds — a torn read is unlikely but possible
// on a busy disk.
// ---------------------------------------------------------------------------

export interface HeartbeatStalenessWatcherOptions {
  agentName: string;
  ctxRoot: string;
  frameworkRoot: string;
  /** Default 60_000. Override for tests with fake timers. */
  pollMs?: number;
  /** Stale when ts age exceeds this. 0 disables the watcher entirely. */
  thresholdMs: number;
  /** Re-alert cadence while still stale. Default 30 min. */
  realertMs: number;
  /**
   * Path B watchdog (watchdog-threshold-tuning spec): alert when an agent
   * holds the same current_task for longer than this without advancing.
   * Reads `task_started_at` from heartbeat.json, ignores `last_heartbeat`,
   * so side-channel surfaces (send-telegram, send-message) refreshing the
   * heartbeat do not mask a wedged task. 0 disables the task-stuck leg
   * while keeping the existing staleness alert.
   */
  taskStuckThresholdMs?: number;
  /** Re-alert cadence while task remains stuck. Default matches realertMs. */
  taskStuckRealertMs?: number;
  /** Optional logger; defaults to console.error so the daemon log file captures the line. */
  logger?: (msg: string) => void;
  /** Injectable clock for tests. Returns now() in ms. */
  now?: () => number;
  /**
   * Fleet-resilience cleanup A: when both are present, emit `heartbeat_stale_detected`
   * and `heartbeat_recovered` as queryable JSONL under the `_daemon` synthetic agent
   * (in addition to the existing stderr lines). Omit in tests that don't need to
   * exercise the wire — the events become stderr-only no-ops, identical to today.
   */
  instanceId?: string;
  org?: string;
}

export class HeartbeatStalenessWatcher {
  private readonly agentName: string;
  private readonly ctxRoot: string;
  private readonly frameworkRoot: string;
  private readonly pollMs: number;
  private readonly thresholdMs: number;
  private readonly realertMs: number;
  private readonly taskStuckThresholdMs: number;
  private readonly taskStuckRealertMs: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;
  private readonly instanceId?: string;
  private readonly org?: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** True once we have seen at least one successful heartbeat read — gates the alert. */
  private armed = false;
  /** Consecutive read failures (missing file / corrupt JSON). Flag stale only at ≥2. */
  private consecutiveFailedReads = 0;
  /** True while the watcher considers this agent stale. */
  private staleSince: number | null = null;
  /** Time of the last alert sent — keyed against the operator-alert cooldown. */
  private lastAlertAt: number | null = null;
  /** Path B: time we first observed the current task as stuck. */
  private taskStuckSince: number | null = null;
  /** Path B: most recent task-stuck alert time, for re-alert cadence. */
  private lastTaskStuckAlertAt: number | null = null;
  /**
   * Path B: tracks the task that was last observed stuck. When current_task
   * changes (any transition), the stuck state resets independent of timing.
   */
  private lastObservedStuckTask: string | null = null;

  constructor(opts: HeartbeatStalenessWatcherOptions) {
    this.agentName = opts.agentName;
    this.ctxRoot = opts.ctxRoot;
    this.frameworkRoot = opts.frameworkRoot;
    this.pollMs = opts.pollMs ?? 60_000;
    this.thresholdMs = opts.thresholdMs;
    this.realertMs = opts.realertMs;
    this.taskStuckThresholdMs = opts.taskStuckThresholdMs ?? 0;
    this.taskStuckRealertMs = opts.taskStuckRealertMs ?? opts.realertMs;
    this.logger = opts.logger ?? ((msg) => console.error(msg));
    this.now = opts.now ?? Date.now;
    this.instanceId = opts.instanceId;
    this.org = opts.org;
  }

  start(): void {
    if (this.timer !== null) return; // already started
    if (this.thresholdMs <= 0) {
      this.logger(`[heartbeat-watcher] disabled for "${this.agentName}" (threshold=${this.thresholdMs})`);
      return;
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests; not part of the public lifecycle. */
  tick(): void {
    const nowMs = this.now();
    const hb = readHeartbeatStatus(this.ctxRoot, this.agentName, nowMs);
    const ageSeconds = hb.lastHeartbeatAgeSeconds;

    if (ageSeconds === undefined) {
      // File missing or unreadable. If we're already armed, count toward the
      // 2-consecutive threshold; otherwise wait for the first successful read.
      if (!this.armed) return;
      this.consecutiveFailedReads += 1;
      if (this.consecutiveFailedReads >= 2) {
        this.flagStale(nowMs, /*ageSeconds*/ -1, hb.lastHeartbeatTask);
      }
      return;
    }

    // Successful read.
    this.consecutiveFailedReads = 0;
    if (!this.armed) {
      this.armed = true;
      this.logger(`[heartbeat-watcher] armed for "${this.agentName}" (first heartbeat observed, age ${ageSeconds}s)`);
    }

    const thresholdSeconds = Math.floor(this.thresholdMs / 1000);
    if (ageSeconds * 1000 > this.thresholdMs) {
      // Idle-suppression: standby agents legitimately go quiet between cron
      // ticks. Alert only when current_task is non-empty (agent is supposed
      // to be working). Do not advance staleSince/lastAlertAt — the next tick
      // that finds a task assigned should treat this as a fresh transition.
      if (!hb.lastHeartbeatTask?.trim()) {
        this.emitIdleSuppressed(ageSeconds, thresholdSeconds);
      } else {
        this.flagStale(nowMs, ageSeconds, hb.lastHeartbeatTask, thresholdSeconds);
      }
    } else if (this.staleSince !== null) {
      this.emitRecovered(nowMs);
    }

    // Path B (additive third leg, independent of staleness): task-stuck alert.
    // Reads `task_started_at` so side-channel heartbeat refreshes don't mask
    // a wedged task. The 2026-05-15 119-min engineer hang is exactly the case
    // this catches by construction.
    this.checkTaskStuck(nowMs, hb.lastHeartbeatTask, hb.taskStartedAt);
  }

  private checkTaskStuck(nowMs: number, task: string | undefined, taskStartedAt: string | undefined): void {
    if (this.taskStuckThresholdMs <= 0) return;
    const trimmedTask = task?.trim();
    // No task held → recover if we were tracking one.
    if (!trimmedTask || !taskStartedAt) {
      if (this.taskStuckSince !== null) this.emitTaskStuckRecovered(nowMs);
      this.lastObservedStuckTask = null;
      return;
    }
    // Task transition resets the stuck clock regardless of timing.
    if (this.lastObservedStuckTask !== null && this.lastObservedStuckTask !== trimmedTask) {
      this.emitTaskStuckRecovered(nowMs);
    }
    const stampedMs = new Date(taskStartedAt).getTime();
    if (!Number.isFinite(stampedMs)) return;
    const heldMs = nowMs - stampedMs;
    if (heldMs > this.taskStuckThresholdMs) {
      this.flagTaskStuck(nowMs, trimmedTask, Math.floor(heldMs / 1000));
    } else if (this.taskStuckSince !== null) {
      // Held duration shrank below threshold (shouldn't normally happen
      // mid-task, but covers clock-skew + tests). Recover.
      this.emitTaskStuckRecovered(nowMs);
    }
  }

  private emitIdleSuppressed(ageSeconds: number, thresholdSeconds: number): void {
    this.logger(
      `[heartbeat-watcher] idle-suppressed agent="${this.agentName}" age_seconds=${ageSeconds}`,
    );
    if (this.instanceId && this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'heartbeat_idle_suppressed', 'info',
        { agent: this.agentName, age_seconds: ageSeconds, threshold_seconds: thresholdSeconds },
      );
    }
  }

  private flagStale(
    nowMs: number,
    ageSeconds: number,
    task: string | undefined,
    thresholdSeconds: number = Math.floor(this.thresholdMs / 1000),
  ): void {
    const justWentStale = this.staleSince === null;
    if (justWentStale) {
      this.staleSince = nowMs;
    }
    // Re-alert cadence — the watcher owns gating. Use strict `<` to mirror
    // operator-alert's boundary semantics: both fire AT exactly the cadence.
    // We pass a small cooldown to operator-alert (1s) so its state file still
    // records `lastSentAt[key]` for daemon-restart audit, but doesn't itself
    // gate (would double-gate at the same boundary with inconsistent < vs >=).
    const elapsed = this.lastAlertAt === null ? Infinity : nowMs - this.lastAlertAt;
    if (elapsed < this.realertMs) return;

    const filePresent = ageSeconds >= 0;
    const ageDisplay = filePresent
      ? `${Math.floor(ageSeconds / 60)}m ${ageSeconds % 60}s`
      : 'heartbeat file missing (≥2 consecutive reads)';
    const message =
      `⚠️ Agent "${this.agentName}" heartbeat stale: ${ageDisplay} (threshold ${Math.floor(thresholdSeconds / 60)}m)\n` +
      (task ? `Last task: "${task}"\n` : '') +
      `Suggested: \`cortextos bus inject ${this.agentName} "ping?"\` to nudge`;

    emitOperatorAlert(this.ctxRoot, this.frameworkRoot, {
      kind: 'heartbeat_stale',
      severity: 'CRITICAL',
      agent: this.agentName,
      text: message,
      cooldownKey: `heartbeat_stale-${this.agentName}`,
      cooldownMs: 1_000, // negligible — watcher.lastAlertAt is the real gate
    });
    this.lastAlertAt = nowMs;
    this.logger(
      `[heartbeat-watcher] heartbeat_stale_detected agent="${this.agentName}" age_seconds=${ageSeconds} ` +
      `threshold_seconds=${thresholdSeconds}`,
    );
    if (this.instanceId && this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'heartbeat_stale_detected', 'warning',
        { agent: this.agentName, age_seconds: ageSeconds, threshold_seconds: thresholdSeconds },
      );
    }
  }

  private emitRecovered(nowMs: number): void {
    const wasStaleForSeconds = this.staleSince !== null
      ? Math.floor((nowMs - this.staleSince) / 1000)
      : 0;
    this.staleSince = null;
    this.lastAlertAt = null;
    this.logger(
      `[heartbeat-watcher] heartbeat_recovered agent="${this.agentName}" ` +
      `was_stale_for_seconds=${wasStaleForSeconds}`,
    );
    if (this.instanceId && this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'heartbeat_recovered', 'info',
        { agent: this.agentName, was_stale_for_seconds: wasStaleForSeconds },
      );
    }
  }

  private flagTaskStuck(nowMs: number, task: string, heldSeconds: number): void {
    const justStuck = this.taskStuckSince === null;
    if (justStuck) {
      this.taskStuckSince = nowMs;
    }
    this.lastObservedStuckTask = task;

    const elapsed = this.lastTaskStuckAlertAt === null ? Infinity : nowMs - this.lastTaskStuckAlertAt;
    if (elapsed < this.taskStuckRealertMs) return;

    const thresholdSeconds = Math.floor(this.taskStuckThresholdMs / 1000);
    const heldDisplay = `${Math.floor(heldSeconds / 60)}m ${heldSeconds % 60}s`;
    const message =
      `⚠️ Agent "${this.agentName}" task stuck: held "${task}" for ${heldDisplay} ` +
      `(threshold ${Math.floor(thresholdSeconds / 60)}m)\n` +
      `Side-channel heartbeat refreshes do NOT mask this signal — task_started_at ` +
      `hasn't moved.\n` +
      `Suggested: \`cortextos bus inject ${this.agentName} "ping?"\` to nudge`;

    // Cooldown key includes a short hash of the task name so a per-task
    // transition (wedged-A → wedged-B back-to-back) gets a fresh dedupe
    // bucket. Without this, a long-cooldown bucket on `task_stuck-<agent>`
    // would suppress a legitimate alert for a different stuck task. The
    // watcher's own `lastTaskStuckAlertAt` already gates re-alerts on the
    // SAME task at this.taskStuckRealertMs cadence; the cooldownMs below
    // matches that and defends against a hypothetical future second
    // emitter of `task_stuck` for the same (agent, task) pair.
    emitOperatorAlert(this.ctxRoot, this.frameworkRoot, {
      kind: 'task_stuck',
      severity: 'CRITICAL',
      agent: this.agentName,
      text: message,
      cooldownKey: `task_stuck-${this.agentName}-${shortHash(task)}`,
      cooldownMs: this.taskStuckRealertMs,
    });
    this.lastTaskStuckAlertAt = nowMs;
    this.logger(
      `[heartbeat-watcher] task_stuck_detected agent="${this.agentName}" task="${task}" ` +
      `held_seconds=${heldSeconds} threshold_seconds=${thresholdSeconds}`,
    );
    if (this.instanceId && this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'task_stuck_detected', 'warning',
        { agent: this.agentName, task, held_seconds: heldSeconds, threshold_seconds: thresholdSeconds },
      );
    }
  }

  private emitTaskStuckRecovered(nowMs: number): void {
    const wasStuckForSeconds = this.taskStuckSince !== null
      ? Math.floor((nowMs - this.taskStuckSince) / 1000)
      : 0;
    const recoveredTask = this.lastObservedStuckTask;
    this.taskStuckSince = null;
    this.lastTaskStuckAlertAt = null;
    this.lastObservedStuckTask = null;
    this.logger(
      `[heartbeat-watcher] task_stuck_recovered agent="${this.agentName}" ` +
      `was_stuck_for_seconds=${wasStuckForSeconds}`,
    );
    if (this.instanceId && this.org !== undefined) {
      logDaemonEvent(
        this.ctxRoot, this.instanceId, this.org,
        'action', 'task_stuck_recovered', 'info',
        { agent: this.agentName, task: recoveredTask, was_stuck_for_seconds: wasStuckForSeconds },
      );
    }
  }

  /** Test-only introspection. */
  get isArmed(): boolean { return this.armed; }
  get isStale(): boolean { return this.staleSince !== null; }
  get isTaskStuck(): boolean { return this.taskStuckSince !== null; }
}
