import { readHeartbeatStatus } from '../utils/agent-status.js';
import { emitOperatorAlert } from './operator-alert.js';

// ---------------------------------------------------------------------------
// Fleet-resilience plan #2 — daemon-side heartbeat-staleness watchdog.
//
// Catches the "PTY alive but Claude wedged inside a tool call" class that no
// other recovery surface sees. The agent's heartbeat.json contains
// `last_heartbeat: ISO8601` and `current_task`. Every event-log write also
// refreshes last_heartbeat (see src/bus/event.ts:refreshHeartbeatTimestamp),
// so as long as the agent is doing *anything* observable the file ticks.
// When it goes silent past `thresholdMs` the watcher escalates.
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
  /** Optional logger; defaults to console.error so the daemon log file captures the line. */
  logger?: (msg: string) => void;
  /** Injectable clock for tests. Returns now() in ms. */
  now?: () => number;
}

export class HeartbeatStalenessWatcher {
  private readonly agentName: string;
  private readonly ctxRoot: string;
  private readonly frameworkRoot: string;
  private readonly pollMs: number;
  private readonly thresholdMs: number;
  private readonly realertMs: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** True once we have seen at least one successful heartbeat read — gates the alert. */
  private armed = false;
  /** Consecutive read failures (missing file / corrupt JSON). Flag stale only at ≥2. */
  private consecutiveFailedReads = 0;
  /** True while the watcher considers this agent stale. */
  private staleSince: number | null = null;
  /** Time of the last alert sent — keyed against the operator-alert cooldown. */
  private lastAlertAt: number | null = null;

  constructor(opts: HeartbeatStalenessWatcherOptions) {
    this.agentName = opts.agentName;
    this.ctxRoot = opts.ctxRoot;
    this.frameworkRoot = opts.frameworkRoot;
    this.pollMs = opts.pollMs ?? 60_000;
    this.thresholdMs = opts.thresholdMs;
    this.realertMs = opts.realertMs;
    this.logger = opts.logger ?? ((msg) => console.error(msg));
    this.now = opts.now ?? Date.now;
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
      this.flagStale(nowMs, ageSeconds, hb.lastHeartbeatTask, thresholdSeconds);
    } else if (this.staleSince !== null) {
      this.emitRecovered(nowMs);
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
  }

  /** Test-only introspection. */
  get isArmed(): boolean { return this.armed; }
  get isStale(): boolean { return this.staleSince !== null; }
}
