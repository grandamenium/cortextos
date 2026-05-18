// Per-agent restart circuit breaker (task #60).
//
// Problem: the daemon will faithfully restart an agent up to max_crashes_per_day
// times even when the underlying cause is an Anthropic API quota event (which
// surfaces in the CLI as 401 OR 429). This burns API quota AND wakes the
// operator with crash alerts that have no actionable fix beyond "wait."
//
// Solution: classify each crash by scanning recent stdout/stderr for known
// fingerprints, then apply two policies:
//   * rate_limit  → exponential cool-down (60s → 1800s cap), reset after
//                   30 min of clean runs
//   * auth        → after 3 occurrences inside a 15-min window, HALT the
//                   agent (no auto-restart) and fire one operator alert
//   * unknown     → leave existing PM2 max_restarts behaviour intact
//
// Unit testable: the classifier is a pure function, and the breaker class
// holds all state in-process with no I/O — the tests can drive it forwards
// with synthetic timestamps via a clock injection.

/**
 * Why the agent restarted, derived from scanning its recent stdout/stderr.
 * Kept narrow on purpose — fewer categories means the policy table stays
 * scannable.
 */
export type RestartCause = 'rate_limit' | 'auth' | 'unknown';

/**
 * Decision returned by `recordExit`. The orchestration layer (agent-process)
 * uses the `cause` to label logs/alerts and the `action` to either schedule
 * the restart at `nextRestartAt` or halt the agent entirely.
 */
export interface RestartDecision {
  cause: RestartCause;
  /**
   * What the manager should do next:
   *   - 'restart'   — schedule restart at `nextRestartAt`
   *   - 'cooldown'  — same as restart, but `delayMs` reflects the breaker's
   *                   added cool-down so the manager can log it loudly
   *   - 'halt'      — do NOT restart; emit operator alert + flip status
   */
  action: 'restart' | 'cooldown' | 'halt';
  /** Delay (ms) before the next restart attempt. Zero on `halt`. */
  delayMs: number;
  /** Wall-clock timestamp the next restart should fire (ms since epoch). */
  nextRestartAt: number;
  /** When true, agent-process should emit a one-off operator Telegram alert. */
  emitAlert: boolean;
  /** Recent auth-failure count inside the rolling window — included for logs. */
  recentAuthCount: number;
  /** Recent rate-limit count inside the rolling window — included for logs. */
  recentRateLimitCount: number;
}

// ---------------------------------------------------------------------------
// Tunables. Held as module-level constants so a future operator override
// (env var / config) can swap them in without restructuring the breaker.
// ---------------------------------------------------------------------------

export const AUTH_WINDOW_MS = 15 * 60 * 1000;       // 15 min auth-fail window
export const AUTH_HALT_THRESHOLD = 3;               // 3 auth fails → HALT
export const RATE_LIMIT_BASE_DELAY_MS = 60 * 1000;  // first rate_limit cool-down
export const RATE_LIMIT_MAX_DELAY_MS = 30 * 60 * 1000; // cap at 1800s = 30 min
export const RATE_LIMIT_RESET_MS = 30 * 60 * 1000;  // 30 min clean → reset

// ---------------------------------------------------------------------------
// Classifier — pure function. Operates on a recent stdout/stderr slice
// (typically the last 200 lines) plus an optional fallback string (e.g. an
// error message captured directly from the spawn site).
//
// Patterns are matched case-insensitively. We deliberately don't try to be
// clever about distinguishing transient 401s (auth) from permanent ones —
// the policy difference is "halt" and operators want that to fire ASAP on
// real auth loss.
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate[ _-]?limit/i,
  /quota[ _-]?exceeded/i,
  /quota/i,
  /too many requests/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /\b401\b/,
  /unauthori[sz]ed/i,
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /api key (?:expired|revoked)/i,
];

/**
 * Inspect a buffer of recent agent output and return the most-likely cause.
 *
 * Precedence rules (when both fingerprints appear in the same buffer):
 *   1. rate_limit wins — operators want quota cool-down even if a 401
 *      appears later (typical sequence: 429 first, retry, 401 from a
 *      key rotation triggered by the rate guard).
 *   2. If only auth patterns appear, return 'auth'.
 *   3. Otherwise 'unknown'.
 *
 * Returns 'unknown' for empty input.
 */
export function classifyExitCause(recentOutput: string): RestartCause {
  if (!recentOutput) return 'unknown';
  const hasRateLimit = RATE_LIMIT_PATTERNS.some((re) => re.test(recentOutput));
  if (hasRateLimit) return 'rate_limit';
  const hasAuth = AUTH_PATTERNS.some((re) => re.test(recentOutput));
  if (hasAuth) return 'auth';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-agent breaker state. One instance covers all agents — keyed by name.
// ---------------------------------------------------------------------------

interface AgentBreakerState {
  /** Sliding window of exit events (timestamp + cause). */
  events: Array<{ ts: number; cause: RestartCause }>;
  /** Exponential delay accumulator for rate-limit recovery (ms). */
  rateLimitDelayMs: number;
  /** Last clean-run reset check timestamp. */
  lastCleanCheckTs: number;
  /** Last time we emitted an operator auth alert (for de-dup). */
  lastAuthAlertTs: number;
}

/**
 * Optional clock function for tests — defaults to `Date.now`. Injecting
 * the clock keeps the breaker pure-state and lets tests drive minutes of
 * activity in microseconds.
 */
export interface ClockFn { (): number }

export class RestartCircuitBreaker {
  private agents: Map<string, AgentBreakerState> = new Map();
  private clock: ClockFn;

  constructor(clock: ClockFn = () => Date.now()) {
    this.clock = clock;
  }

  /**
   * Record an exit event for `agentName` and return a decision the caller
   * should act on. The caller is responsible for ACTUALLY scheduling the
   * restart (or halting); this method's only side effect is updating
   * in-memory breaker state.
   *
   * @param agentName   the agent that just exited
   * @param recentOutput a buffer of the last ~200 lines of stdout/stderr
   *                     used by the classifier
   * @param baseBackoffMs the manager's existing backoff for this crash (so
   *                     a rate_limit cool-down can be max(base, cooldown)
   *                     instead of resetting backoff progress)
   */
  recordExit(
    agentName: string,
    recentOutput: string,
    baseBackoffMs: number,
  ): RestartDecision {
    const now = this.clock();
    const cause = classifyExitCause(recentOutput);
    const state = this.getOrCreateState(agentName);

    // Reset rate-limit cool-down accumulator BEFORE recording the new event —
    // otherwise lastEventTs('rate_limit') would return `now` and the gap
    // check (now - lastTs >= RATE_LIMIT_RESET_MS) could never be true on
    // a back-to-back recordExit sequence.
    if (state.rateLimitDelayMs > 0) {
      const lastRateLimit = this.lastEventTs(state, 'rate_limit');
      if (lastRateLimit !== null && now - lastRateLimit >= RATE_LIMIT_RESET_MS) {
        state.rateLimitDelayMs = 0;
      }
    }

    // Now record the new event and prune anything older than the longest window.
    state.events.push({ ts: now, cause });
    this.pruneOldEvents(state, now);
    state.lastCleanCheckTs = now;

    // ---- HALT policy: auth-failure storm ----
    const recentAuth = this.countSince(state, 'auth', now - AUTH_WINDOW_MS);
    const recentRate = this.countSince(state, 'rate_limit', now - AUTH_WINDOW_MS);

    if (cause === 'auth' && recentAuth >= AUTH_HALT_THRESHOLD) {
      // Dedup alerts: only emit if we haven't alerted in this window.
      const shouldAlert = now - state.lastAuthAlertTs >= AUTH_WINDOW_MS;
      if (shouldAlert) state.lastAuthAlertTs = now;
      return {
        cause,
        action: 'halt',
        delayMs: 0,
        nextRestartAt: 0,
        emitAlert: shouldAlert,
        recentAuthCount: recentAuth,
        recentRateLimitCount: recentRate,
      };
    }

    // ---- COOLDOWN policy: exponential back-off on rate_limit ----
    if (cause === 'rate_limit') {
      state.rateLimitDelayMs = state.rateLimitDelayMs === 0
        ? RATE_LIMIT_BASE_DELAY_MS
        : Math.min(state.rateLimitDelayMs * 2, RATE_LIMIT_MAX_DELAY_MS);
      const delay = Math.max(state.rateLimitDelayMs, baseBackoffMs);
      return {
        cause,
        action: 'cooldown',
        delayMs: delay,
        nextRestartAt: now + delay,
        emitAlert: false,
        recentAuthCount: recentAuth,
        recentRateLimitCount: recentRate,
      };
    }

    // ---- UNKNOWN: preserve existing back-off behaviour ----
    return {
      cause,
      action: 'restart',
      delayMs: baseBackoffMs,
      nextRestartAt: now + baseBackoffMs,
      emitAlert: false,
      recentAuthCount: recentAuth,
      recentRateLimitCount: recentRate,
    };
  }

  /**
   * Notify the breaker an agent ran cleanly for at least RATE_LIMIT_RESET_MS.
   * Resets the rate-limit cool-down accumulator without prejudicing the auth
   * window — auth halts are operator-actionable and shouldn't be reset on
   * a single quiet run.
   *
   * Call site: agent-process.ts should ping this when an agent's session has
   * been alive for ≥ 30 min without a crash.
   */
  notifyCleanRun(agentName: string): void {
    const state = this.agents.get(agentName);
    if (!state) return;
    state.rateLimitDelayMs = 0;
  }

  /**
   * Reset all per-agent state for a given agent. Called when an operator
   * manually re-enables a halted agent via `cortextos start <agent>` so the
   * fresh restart isn't immediately re-halted by the prior window.
   */
  reset(agentName: string): void {
    this.agents.delete(agentName);
  }

  /** Read-only access to in-memory state for diagnostics + tests. */
  inspect(agentName: string): Readonly<AgentBreakerState> | undefined {
    return this.agents.get(agentName);
  }

  // --- Private helpers ---

  private getOrCreateState(agentName: string): AgentBreakerState {
    let s = this.agents.get(agentName);
    if (!s) {
      s = {
        events: [],
        rateLimitDelayMs: 0,
        lastCleanCheckTs: 0,
        lastAuthAlertTs: 0,
      };
      this.agents.set(agentName, s);
    }
    return s;
  }

  private pruneOldEvents(state: AgentBreakerState, now: number): void {
    // Keep events newer than the LONGER of the two windows (auth 15m vs
    // rate-limit reset 30m). Belt-and-suspenders against unbounded growth.
    const cutoff = now - Math.max(AUTH_WINDOW_MS, RATE_LIMIT_RESET_MS);
    state.events = state.events.filter((e) => e.ts >= cutoff);
  }

  private countSince(
    state: AgentBreakerState,
    cause: RestartCause,
    sinceTs: number,
  ): number {
    let n = 0;
    for (const e of state.events) {
      if (e.ts >= sinceTs && e.cause === cause) n++;
    }
    return n;
  }

  private lastEventTs(
    state: AgentBreakerState,
    cause: RestartCause,
  ): number | null {
    let last: number | null = null;
    for (const e of state.events) {
      if (e.cause === cause) last = e.ts;
    }
    return last;
  }
}
