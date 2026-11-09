/**
 * sleep-wake-detector.ts — host sleep/wake detection via wall-clock tick gaps.
 *
 * Node timers freeze while the host sleeps (clamshell lid-close, suspend).
 * A short repeating tick therefore observes a wall-clock jump roughly equal
 * to the time slept. This module turns those jumps into ONE notification per
 * sleep episode:
 *
 *  - a tick gap ≥ gapThresholdMs opens (or extends) a sleep episode;
 *  - the episode closes only after settleTicks consecutive on-time ticks
 *    (sustained uptime is the FullWake proxy — cross-platform, no pmset
 *    dependency). macOS Power Nap dark-wakes are shorter than the settle
 *    window, so intermittent dark-wakes during one lid-closed stretch merge
 *    into a single episode instead of emitting a notification per dark-wake;
 *  - on close, onWake fires once with the episode's full span and the
 *    cumulative time actually spent asleep across merged gaps.
 *
 * The onWake callback is isolated: a throwing callback is logged and never
 * propagates into the daemon's timer loop.
 */

export interface SleepEpisode {
  /** Wall-clock ms of the last on-time tick before the first gap — i.e. when the host fell asleep (±1 tick). */
  sleptFromMs: number;
  /** Wall-clock ms of the tick that observed the final gap — i.e. when the host came back. */
  wokeAtMs: number;
  /** Cumulative ms spent asleep across all merged gaps in this episode. */
  totalSleptMs: number;
  /** Number of distinct gaps merged into this episode (1 = single uninterrupted sleep). */
  gapCount: number;
}

export interface SleepWakeDetectorOptions {
  /** Called exactly once per closed sleep episode. */
  onWake: (episode: SleepEpisode) => void;
  /** Minimum tick gap that counts as sleep. Default 10 minutes. */
  gapThresholdMs?: number;
  /** Tick cadence. Default 15s. */
  tickIntervalMs?: number;
  /** Consecutive on-time ticks required to close an episode. Default 6 (90s sustained uptime). */
  settleTicks?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /** Injectable logger. Default console.log. */
  logger?: (msg: string) => void;
}

export const DEFAULT_GAP_THRESHOLD_MS = 10 * 60_000;
export const DEFAULT_TICK_INTERVAL_MS = 15_000;
export const DEFAULT_SETTLE_TICKS = 6;

export class SleepWakeDetector {
  private readonly onWake: (episode: SleepEpisode) => void;
  private readonly gapThresholdMs: number;
  private readonly tickIntervalMs: number;
  private readonly settleTicks: number;
  private readonly now: () => number;
  private readonly logger: (msg: string) => void;

  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private episode: SleepEpisode | null = null;
  private settleCount = 0;

  constructor(opts: SleepWakeDetectorOptions) {
    this.onWake = opts.onWake;
    this.gapThresholdMs = opts.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.settleTicks = opts.settleTicks ?? DEFAULT_SETTLE_TICKS;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? ((msg: string) => console.log(msg));
  }

  start(): void {
    if (this.tickHandle !== null) return;
    this.lastTickMs = this.now();
    this.tickHandle = setInterval(() => this.tick(), this.tickIntervalMs);
    // Never hold the process open on our account (crash paths, tests).
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.episode = null;
    this.settleCount = 0;
  }

  /** True while a sleep episode is open (host recently woke, settle pending). */
  inSleepAdjacentWindow(): boolean {
    return this.episode !== null;
  }

  /**
   * One detector tick. Runs on the interval; exposed for tests so a fake
   * clock can drive gap/settle sequences deterministically.
   */
  tick(): void {
    const now = this.now();
    const gap = now - this.lastTickMs;
    const prevTickMs = this.lastTickMs;
    this.lastTickMs = now;

    if (gap >= this.gapThresholdMs) {
      if (this.episode === null) {
        this.episode = {
          sleptFromMs: prevTickMs,
          wokeAtMs: now,
          totalSleptMs: gap,
          gapCount: 1,
        };
      } else {
        // Another gap before settle completed — same lid-closed stretch
        // (dark-wake pattern). Merge into the open episode.
        this.episode.wokeAtMs = now;
        this.episode.totalSleptMs += gap;
        this.episode.gapCount += 1;
      }
      this.settleCount = 0;
      this.logger(
        `[sleep-wake] gap ${Math.round(gap / 1000)}s detected ` +
        `(episode total ${Math.round(this.episode.totalSleptMs / 1000)}s across ${this.episode.gapCount} gap(s)) — settling`
      );
      return;
    }

    if (this.episode !== null) {
      this.settleCount += 1;
      if (this.settleCount >= this.settleTicks) {
        const episode = this.episode;
        this.episode = null;
        this.settleCount = 0;
        try {
          this.onWake(episode);
        } catch (err) {
          this.logger(
            `[sleep-wake] onWake callback threw (ignored): ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
}

/** Format a duration as a compact human string: "3h 29m", "12m", "45s". */
export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Format epoch ms as "HH:MM" UTC. */
export function hhmmUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
