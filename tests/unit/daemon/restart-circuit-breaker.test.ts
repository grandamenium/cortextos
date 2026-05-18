import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyExitCause,
  RestartCircuitBreaker,
  AUTH_HALT_THRESHOLD,
  AUTH_WINDOW_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_RESET_MS,
} from '../../../src/daemon/restart-circuit-breaker.js';

// ---------------------------------------------------------------------------
// Classifier — pure function, no clock dependency.
// ---------------------------------------------------------------------------

describe('classifyExitCause', () => {
  it('returns "unknown" for empty input', () => {
    expect(classifyExitCause('')).toBe('unknown');
  });

  it('returns "rate_limit" on common 429 / quota fingerprints', () => {
    expect(classifyExitCause('HTTP 429 Too Many Requests')).toBe('rate_limit');
    expect(classifyExitCause('Error: rate limit exceeded')).toBe('rate_limit');
    expect(classifyExitCause('error: quota exceeded')).toBe('rate_limit');
    expect(classifyExitCause('429 too many requests')).toBe('rate_limit');
    expect(classifyExitCause('your quota has been used up')).toBe('rate_limit');
  });

  it('returns "auth" on 401 / unauthorized / login fingerprints', () => {
    expect(classifyExitCause('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyExitCause('Error: please run /login to continue')).toBe('auth');
    expect(classifyExitCause('Not logged in')).toBe('auth');
    expect(classifyExitCause('Invalid API key')).toBe('auth');
    expect(classifyExitCause('Unauthorised request')).toBe('auth');
    expect(classifyExitCause('API key expired')).toBe('auth');
  });

  it('prefers rate_limit when both fingerprints appear (precedence)', () => {
    const mixed = '429 Too Many Requests\n... retry ...\n401 Unauthorized';
    expect(classifyExitCause(mixed)).toBe('rate_limit');
  });

  it('returns "unknown" for unrelated noise / normal output', () => {
    expect(classifyExitCause('Build successful in 1.2s')).toBe('unknown');
    expect(classifyExitCause('Goodbye!')).toBe('unknown');
    // Word-boundary guards: numbers embedded inside words don't false-positive
    // on the auth pattern. `401MB` has no \b between 1 and M, so it stays
    // 'unknown' — the bare "401" token is what authenticates the match.
    expect(classifyExitCause('Allocated 401MB of heap')).toBe('unknown');
    expect(classifyExitCause('Took 4290ms')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Breaker behaviour — driven via injected clock so tests can simulate
// minutes of activity in microseconds. Each test starts fresh.
// ---------------------------------------------------------------------------

describe('RestartCircuitBreaker', () => {
  // A movable clock — assignment updates current "now" returned to breaker.
  let nowMs: number;
  let breaker: RestartCircuitBreaker;

  beforeEach(() => {
    nowMs = 1_700_000_000_000; // arbitrary fixed epoch
    breaker = new RestartCircuitBreaker(() => nowMs);
  });

  // -------------------------------------------------------------------------
  // a) 3 rate_limit crashes → exponential cool-down applied.
  // -------------------------------------------------------------------------
  it('applies exponential cool-down to consecutive rate_limit crashes', () => {
    const baseBackoff = 5000;

    const d1 = breaker.recordExit('forge', '429 too many requests', baseBackoff);
    expect(d1.action).toBe('cooldown');
    expect(d1.cause).toBe('rate_limit');
    // First rate_limit → base delay = 60s.
    expect(d1.delayMs).toBe(RATE_LIMIT_BASE_DELAY_MS);

    // Move forward 30s and crash again with rate_limit.
    nowMs += 30_000;
    const d2 = breaker.recordExit('forge', 'rate limit hit', baseBackoff);
    expect(d2.action).toBe('cooldown');
    // Second crash doubles the accumulator: 120s.
    expect(d2.delayMs).toBe(RATE_LIMIT_BASE_DELAY_MS * 2);

    nowMs += 30_000;
    const d3 = breaker.recordExit('forge', '429 Too Many Requests', baseBackoff);
    expect(d3.action).toBe('cooldown');
    // Third crash: 240s.
    expect(d3.delayMs).toBe(RATE_LIMIT_BASE_DELAY_MS * 4);

    // Verify the cap eventually engages.
    nowMs += 30_000;
    breaker.recordExit('forge', '429', baseBackoff); // 480s
    nowMs += 30_000;
    breaker.recordExit('forge', '429', baseBackoff); // 960s
    nowMs += 30_000;
    const d6 = breaker.recordExit('forge', '429', baseBackoff); // would be 1920s, capped
    expect(d6.delayMs).toBe(RATE_LIMIT_MAX_DELAY_MS);
  });

  it('uses max(baseBackoff, breakerDelay) so existing backoff isn\'t shortened', () => {
    const baseBackoff = 5 * 60_000; // 5 min — exceeds first cool-down (60s)
    const d = breaker.recordExit('forge', '429', baseBackoff);
    expect(d.action).toBe('cooldown');
    expect(d.delayMs).toBe(baseBackoff); // longer wins
  });

  it('resets rate-limit accumulator after a quiet period > RATE_LIMIT_RESET_MS', () => {
    breaker.recordExit('forge', '429', 5000); // delay = 60s, accumulator = 60s

    // Jump forward beyond the reset window — agent ran clean for >30 min.
    nowMs += RATE_LIMIT_RESET_MS + 1_000;

    const d2 = breaker.recordExit('forge', '429', 5000);
    // Accumulator was reset, so this rate_limit starts from base again.
    expect(d2.delayMs).toBe(RATE_LIMIT_BASE_DELAY_MS);
  });

  // -------------------------------------------------------------------------
  // b) 3 auth crashes in 15 min → halt + alert path triggered.
  // -------------------------------------------------------------------------
  it('halts and alerts after AUTH_HALT_THRESHOLD auth crashes in window', () => {
    const baseBackoff = 5000;

    const d1 = breaker.recordExit('sam', '401 Unauthorized', baseBackoff);
    expect(d1.action).toBe('restart'); // not enough auth events yet
    expect(d1.cause).toBe('auth');

    nowMs += 60_000;
    const d2 = breaker.recordExit('sam', 'please run /login', baseBackoff);
    expect(d2.action).toBe('restart');

    nowMs += 60_000;
    const d3 = breaker.recordExit('sam', 'Not logged in', baseBackoff);
    // Third auth crash within 15 min → HALT.
    expect(d3.action).toBe('halt');
    expect(d3.cause).toBe('auth');
    expect(d3.emitAlert).toBe(true);
    expect(d3.recentAuthCount).toBe(AUTH_HALT_THRESHOLD);
  });

  it('dedups auth alerts — a 4th auth crash in same window does not re-alert', () => {
    // Trip the halt threshold first.
    breaker.recordExit('sam', '401', 5000);
    nowMs += 60_000;
    breaker.recordExit('sam', '401', 5000);
    nowMs += 60_000;
    const haltDecision = breaker.recordExit('sam', '401', 5000);
    expect(haltDecision.emitAlert).toBe(true);

    // 4th auth event a minute later — still in halt state, but emitAlert
    // must be false so we don't spam the operator.
    nowMs += 60_000;
    const d4 = breaker.recordExit('sam', '401', 5000);
    expect(d4.action).toBe('halt');
    expect(d4.emitAlert).toBe(false);
  });

  it('forgets auth events outside the 15-min window (rolling, not cumulative)', () => {
    breaker.recordExit('sam', '401', 5000);
    // Jump forward beyond the auth window — old event ages out.
    nowMs += AUTH_WINDOW_MS + 1_000;
    breaker.recordExit('sam', '401', 5000);
    const d3 = breaker.recordExit('sam', '401', 5000);
    // Only 2 events in current window — no halt.
    expect(d3.action).toBe('restart');
    expect(d3.recentAuthCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // c) Mixed / unknown patterns don't trip either path.
  // -------------------------------------------------------------------------
  it('does not trip rate-limit or auth paths on unknown crashes', () => {
    const baseBackoff = 7000;

    const d1 = breaker.recordExit('analyst', 'Segmentation fault', baseBackoff);
    expect(d1.cause).toBe('unknown');
    expect(d1.action).toBe('restart');
    expect(d1.delayMs).toBe(baseBackoff);
    expect(d1.emitAlert).toBe(false);

    // Pile on more unknowns — still no halt, still no cool-down.
    for (let i = 0; i < 10; i++) {
      nowMs += 30_000;
      const d = breaker.recordExit('analyst', 'unrelated crash log', baseBackoff);
      expect(d.action).toBe('restart');
      expect(d.delayMs).toBe(baseBackoff);
    }
  });

  it('handles mixed kinds correctly — auth count + rate count tracked separately', () => {
    breaker.recordExit('chief', '429', 5000); // rate_limit
    nowMs += 30_000;
    breaker.recordExit('chief', 'segfault', 5000); // unknown
    nowMs += 30_000;
    breaker.recordExit('chief', '401', 5000); // auth #1
    nowMs += 30_000;
    breaker.recordExit('chief', '401', 5000); // auth #2
    nowMs += 30_000;
    const d = breaker.recordExit('chief', '401', 5000); // auth #3 → halt
    expect(d.action).toBe('halt');
    expect(d.recentAuthCount).toBe(3);
    expect(d.recentRateLimitCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Misc operational helpers.
  // -------------------------------------------------------------------------
  it('reset() wipes per-agent state — supports operator manual recovery', () => {
    breaker.recordExit('sam', '401', 5000);
    breaker.recordExit('sam', '401', 5000);
    breaker.recordExit('sam', '401', 5000);
    expect(breaker.inspect('sam')?.events.length).toBe(3);

    breaker.reset('sam');
    expect(breaker.inspect('sam')).toBeUndefined();

    // Post-reset, breaker treats it as a fresh start.
    const d = breaker.recordExit('sam', '401', 5000);
    expect(d.action).toBe('restart');
    expect(d.recentAuthCount).toBe(1);
  });

  it('notifyCleanRun() clears the rate-limit accumulator without ageing out events', () => {
    breaker.recordExit('forge', '429', 5000);
    breaker.recordExit('forge', '429', 5000);
    const before = breaker.inspect('forge');
    expect(before?.rateLimitDelayMs).toBeGreaterThan(0);

    breaker.notifyCleanRun('forge');
    expect(breaker.inspect('forge')?.rateLimitDelayMs).toBe(0);

    // Next rate_limit starts at base delay again.
    const d = breaker.recordExit('forge', '429', 5000);
    expect(d.delayMs).toBe(RATE_LIMIT_BASE_DELAY_MS);
  });

  it('isolates state per-agent', () => {
    breaker.recordExit('sam', '401', 5000);
    breaker.recordExit('sam', '401', 5000);
    breaker.recordExit('sam', '401', 5000); // sam halts
    const samDecision = breaker.inspect('sam');
    expect(samDecision?.events.length).toBe(3);

    // forge is fresh — no contamination.
    const d = breaker.recordExit('forge', 'unrelated crash', 5000);
    expect(d.action).toBe('restart');
    expect(d.cause).toBe('unknown');
    expect(d.recentAuthCount).toBe(0);
  });
});
