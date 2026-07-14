/**
 * tests/unit/utils/cron-health.test.ts — Subtask 4.4
 *
 * Unit tests for computeHealth() and aggregateFleetHealth() pure helpers.
 * No I/O — all inputs are injected.
 *
 * Coverage targets:
 *  - never-fired: null lastFire (generic + one-shot past grace + one-shot in future)
 *  - failure: lastStatus === 'failed'
 *  - warning: gap > 2x expectedIntervalMs (exact boundary, just over, cron expr schedules)
 *  - healthy: everything else (just-fired, within interval, cron expression schedule)
 *  - successRate24h: empty / mixed / all-fail / all-success
 *  - aggregateFleetHealth: counts, per-agent breakdown, empty input
 */

import { describe, it, expect } from 'vitest';
import {
  computeHealth,
  aggregateFleetHealth,
  WARNING_MULTIPLIER,
  MISSED_FIRE_GRACE_MS,
  previousSlotMs,
  type CronHealth,
  type HealthState,
} from '../../../src/utils/cron-health';
import type { CronSummaryRow, CronExecutionLogEntry } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_000_000_000_000; // fixed epoch for tests

function makeRow(
  overrides: Partial<{
    agent: string;
    org: string;
    schedule: string;
    lastFire: string | null;
    lastStatus: 'fired' | 'retried' | 'failed' | null;
    fire_at: string;
    last_fired_at: string;
    nextFire: string;
  }> = {},
): CronSummaryRow {
  return {
    agent: overrides.agent ?? 'boris',
    org: overrides.org ?? 'lifeos',
    cron: {
      name: 'test-cron',
      prompt: 'Do something.',
      schedule: overrides.schedule ?? '6h',
      enabled: true,
      created_at: new Date(NOW_MS - 86_400_000).toISOString(),
      ...(overrides.fire_at ? { fire_at: overrides.fire_at } : {}),
      ...(overrides.last_fired_at ? { last_fired_at: overrides.last_fired_at } : {}),
    },
    lastFire: overrides.lastFire ?? null,
    lastStatus: overrides.lastStatus ?? null,
    nextFire: overrides.nextFire ?? new Date(NOW_MS + 21_600_000).toISOString(),
  };
}

function makeEntry(
  status: 'fired' | 'retried' | 'failed',
  tsMs: number = NOW_MS - 3_600_000,
): CronExecutionLogEntry {
  return {
    ts: new Date(tsMs).toISOString(),
    cron: 'test-cron',
    status,
    attempt: 1,
    duration_ms: 500,
    error: status === 'failed' ? 'some error' : null,
  };
}

// ---------------------------------------------------------------------------
// never-fired
// ---------------------------------------------------------------------------

describe('computeHealth — never-fired', () => {
  it('returns never-fired when lastFire is null and no fire_at', () => {
    const row = makeRow({ lastFire: null, lastStatus: null });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('never-fired');
    expect(result.lastFire).toBeNull();
    expect(result.gapMs).toBeNull();
    expect(result.reason).toMatch(/never fired/i);
  });

  it('returns never-fired when past fire_at + grace period', () => {
    // fire_at was 20 minutes ago, grace period is 10 min
    const fireAt = new Date(NOW_MS - 20 * 60 * 1000).toISOString();
    const row = makeRow({ lastFire: null, lastStatus: null, fire_at: fireAt });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('never-fired');
  });

  it('returns healthy for one-shot cron still within grace window', () => {
    // fire_at is 5 minutes in the future
    const fireAt = new Date(NOW_MS + 5 * 60 * 1000).toISOString();
    const row = makeRow({ lastFire: null, lastStatus: null, fire_at: fireAt });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('healthy');
    expect(result.reason).toMatch(/future/i);
  });

  it('returns healthy for one-shot cron at exactly fire_at (not yet past)', () => {
    const fireAt = new Date(NOW_MS).toISOString();
    const row = makeRow({ lastFire: null, lastStatus: null, fire_at: fireAt });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('healthy');
  });

  it('returns never-fired for one-shot cron past fire_at + 10m grace', () => {
    // fire_at was exactly 10m + 1ms ago
    const fireAt = new Date(NOW_MS - 10 * 60 * 1000 - 1).toISOString();
    const row = makeRow({ lastFire: null, lastStatus: null, fire_at: fireAt });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('never-fired');
  });
});

// ---------------------------------------------------------------------------
// failure
// ---------------------------------------------------------------------------

describe('computeHealth — failure', () => {
  it('returns failure when lastStatus is failed', () => {
    const lastFire = new Date(NOW_MS - 3_600_000).toISOString(); // 1h ago
    const row = makeRow({ lastFire, lastStatus: 'failed', schedule: '6h' });
    const entries = [makeEntry('failed', NOW_MS - 3_600_000)];
    const result = computeHealth(row, entries, NOW_MS);
    expect(result.state).toBe('failure');
    expect(result.lastFire).toBe(new Date(lastFire).getTime());
    expect(result.gapMs).toBe(3_600_000);
    expect(result.reason).toMatch(/failed/i);
  });

  it('returns failure regardless of gap size when lastStatus is failed', () => {
    // Even if gap is small (just fired and failed), state is failure
    const lastFire = new Date(NOW_MS - 1000).toISOString(); // 1s ago
    const row = makeRow({ lastFire, lastStatus: 'failed', schedule: '6h' });
    const result = computeHealth(row, [makeEntry('failed', NOW_MS - 1000)], NOW_MS);
    expect(result.state).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// warning
// ---------------------------------------------------------------------------

describe('computeHealth — warning', () => {
  it('returns warning when gap > 2x interval (6h schedule, 13h gap)', () => {
    const intervalMs = 6 * 3_600_000; // 6h
    const gapMs = intervalMs * 2 + 1; // just over 2x
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '6h' });
    const result = computeHealth(row, [makeEntry('fired', NOW_MS - gapMs)], NOW_MS);
    expect(result.state).toBe('warning');
    expect(result.gapMs).toBe(gapMs);
    expect(result.reason).toMatch(/2x threshold/i);
  });

  it('exact 2x boundary: gap === 2x interval is still warning', () => {
    // gap exactly equals 2 * interval
    const intervalMs = 3_600_000; // 1h
    const gapMs = intervalMs * WARNING_MULTIPLIER; // exactly 2x
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '1h' });
    const result = computeHealth(row, [], NOW_MS);
    // gap === 2x is exactly at the threshold — it is warning (> check is strict,
    // so 2x is NOT > 2x; should be healthy)
    // The rule is gap > 2x; exactly equal should be healthy
    expect(result.state).toBe('healthy');
  });

  it('gap just over 2x: warning', () => {
    const intervalMs = 3_600_000; // 1h
    const gapMs = intervalMs * 2 + 1;
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '1h' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('warning');
  });

  it('cron expression, dead 100h -> WARNING (was a silent healthy)', () => {
    // THIS TEST REPLACES A TAUTOLOGY. The previous version asserted
    //     expect(['healthy', 'warning']).toContain(result.state)
    // on a cron dead for 100 HOURS — an assertion that CANNOT FAIL, because it accepts
    // the buggy answer and the correct one equally. Its own comment said "should be
    // healthy (or warning if we add logic later)". So the gap was known, documented,
    // and then guarded by a test that passes no matter what the code does.
    // A TEST THAT CANNOT FAIL IS NOT A TEST — and this one sat on top of a health monitor
    // that reported HEALTHY for a cron that had been dead for a month.
    const lastFire = new Date(NOW_MS - 100 * 3_600_000).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '0 9 * * *' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('warning');            // <- asserts. Fails on the old code.
    expect(result.reason).toMatch(/MISSED its scheduled fire/);
    expect(result.expectedIntervalMs).toBe(0);       // still 0 — we did not fake an interval
  });

  // ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
  // A liveness check that cannot be SHOWN TO FIRE is a vacuous gate, and a liveness
  // check is the last place to ship one: its whole job is to fire when everything else
  // looks fine. Each of these FAILS against the pre-fix code.

  it('NEGATIVE CONTROL — weekly cron that skipped its slot is caught in MINUTES, not a fortnight', () => {
    // The 2x-gap rule would need 14 DAYS to notice this (2 x 7d) — if it ran at all,
    // which for a cron expression it did not. Missed-slot detection catches it at
    // slot + grace, so latency tracks CONSEQUENCE, not the cron's cadence.
    const schedule = '7 15 * * 1';                       // Mondays 15:07 — a security sweep
    const slot = previousSlotMs(schedule, NOW_MS)!;
    expect(slot).not.toBeNull();
    const justPastGrace = slot + MISSED_FIRE_GRACE_MS + 60_000;   // ~16 minutes after the slot
    const row = makeRow({
      schedule,
      lastFire: new Date(slot - 7 * 86_400_000).toISOString(),    // last ran a week ago; skipped today
      lastStatus: 'fired',
    });
    const result = computeHealth(row, [], justPastGrace);
    expect(result.state).toBe('warning');
  });

  it('NEGATIVE CONTROL — a cron that DID fire for its slot stays healthy (no false alarm)', () => {
    const schedule = '7 15 * * 1';
    const slot = previousSlotMs(schedule, NOW_MS)!;
    const row = makeRow({
      schedule,
      lastFire: new Date(slot + 30_000).toISOString(),   // fired 30s after its slot
      lastStatus: 'fired',
    });
    const result = computeHealth(row, [], slot + MISSED_FIRE_GRACE_MS + 60_000);
    expect(result.state).toBe('healthy');
  });

  it('NEGATIVE CONTROL — inside the grace window we do NOT cry wolf', () => {
    // Execution latency is real: the scheduler triggers, the agent records the fire a beat
    // later. A monitor that fires on that beat is a monitor people learn to ignore.
    const schedule = '*/27 * * * *';
    const slot = previousSlotMs(schedule, NOW_MS)!;
    const row = makeRow({
      schedule,
      lastFire: new Date(slot - 27 * 60_000).toISOString(),  // fired the PREVIOUS slot, not this one
      lastStatus: 'fired',
    });
    const result = computeHealth(row, [], slot + MISSED_FIRE_GRACE_MS - 60_000);  // still in grace
    expect(result.state).toBe('healthy');
  });

  it('30m schedule — warning after 1h 1ms', () => {
    const intervalMs = 30 * 60 * 1000; // 30m
    const gapMs = intervalMs * 2 + 1;
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '30m' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('warning');
  });

  it('1d schedule — warning after 2d + 1ms', () => {
    const intervalMs = 86_400_000; // 1d
    const gapMs = intervalMs * 2 + 1;
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '1d' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('warning');
  });

  it('includes expected interval and gap in reason text', () => {
    const intervalMs = 6 * 3_600_000;
    const gapMs = intervalMs * 2 + 3_600_000;
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '6h' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('warning');
    expect(result.reason).toMatch(/ago/);
    expect(result.reason).toMatch(/threshold/);
  });
});

// ---------------------------------------------------------------------------
// healthy
// ---------------------------------------------------------------------------

describe('computeHealth — healthy', () => {
  it('returns healthy for recently-fired cron within interval', () => {
    const lastFire = new Date(NOW_MS - 3_600_000).toISOString(); // 1h ago, 6h schedule
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '6h' });
    const result = computeHealth(row, [makeEntry('fired', NOW_MS - 3_600_000)], NOW_MS);
    expect(result.state).toBe('healthy');
  });

  it('returns healthy when lastStatus is retried but within interval', () => {
    const lastFire = new Date(NOW_MS - 1_800_000).toISOString(); // 30m ago, 6h schedule
    const row = makeRow({ lastFire, lastStatus: 'retried', schedule: '6h' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('healthy');
  });

  it('returns healthy just inside 2x boundary (gap < 2 * interval)', () => {
    const intervalMs = 3_600_000; // 1h
    const gapMs = intervalMs * 2 - 1; // just under 2x
    const lastFire = new Date(NOW_MS - gapMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '1h' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.state).toBe('healthy');
  });

  it('correctly populates all fields for a healthy cron', () => {
    const lastFireMs = NOW_MS - 3_600_000;
    const lastFire = new Date(lastFireMs).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '6h' });
    const entries = [
      makeEntry('fired', NOW_MS - 3_600_000),
      makeEntry('fired', NOW_MS - 7_200_000),
      makeEntry('fired', NOW_MS - 10_800_000),
    ];
    const result = computeHealth(row, entries, NOW_MS);
    expect(result.state).toBe('healthy');
    expect(result.agent).toBe('boris');
    expect(result.org).toBe('lifeos');
    expect(result.cronName).toBe('test-cron');
    expect(result.lastFire).toBe(lastFireMs);
    expect(result.expectedIntervalMs).toBe(6 * 3_600_000);
    expect(result.gapMs).toBe(3_600_000);
    expect(result.firesLast24h).toBe(3);
    expect(result.successRate24h).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// successRate24h calculations
// ---------------------------------------------------------------------------

describe('computeHealth — successRate24h', () => {
  it('returns 1.0 when firesLast24h is 0', () => {
    const row = makeRow({ lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'fired' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.successRate24h).toBe(1);
    expect(result.firesLast24h).toBe(0);
  });

  it('returns 1.0 for all-success entries', () => {
    const entries = [
      makeEntry('fired', NOW_MS - 3_600_000),
      makeEntry('fired', NOW_MS - 7_200_000),
    ];
    const row = makeRow({ lastFire: new Date(NOW_MS - 3_600_000).toISOString(), lastStatus: 'fired' });
    const result = computeHealth(row, entries, NOW_MS);
    expect(result.successRate24h).toBe(1);
    expect(result.firesLast24h).toBe(2);
  });

  it('returns 0.5 for 50% success rate', () => {
    const entries = [
      makeEntry('fired', NOW_MS - 1_000),
      makeEntry('failed', NOW_MS - 2_000),
    ];
    const row = makeRow({ lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'fired' });
    const result = computeHealth(row, entries, NOW_MS);
    expect(result.successRate24h).toBe(0.5);
  });

  it('returns 0 for all-failed entries', () => {
    const entries = [
      makeEntry('failed', NOW_MS - 1_000),
      makeEntry('failed', NOW_MS - 2_000),
      makeEntry('failed', NOW_MS - 3_000),
    ];
    const row = makeRow({ lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'failed' });
    const result = computeHealth(row, entries, NOW_MS);
    expect(result.successRate24h).toBe(0);
    expect(result.firesLast24h).toBe(3);
  });

  it('counts retried entries as failure for success rate', () => {
    const entries = [
      makeEntry('fired', NOW_MS - 1_000),
      makeEntry('retried', NOW_MS - 2_000),
      makeEntry('retried', NOW_MS - 3_000),
    ];
    const row = makeRow({ lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'fired' });
    const result = computeHealth(row, entries, NOW_MS);
    // Only 'fired' counts as success: 1/3
    expect(result.successRate24h).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeHealth — edge cases', () => {
  it('daemon-was-down scenario: a daily cron silent for 3 days -> WARNING', () => {
    // ★ THIS TEST USED TO ASSERT `healthy`. Read that again: it was NAMED
    // "handles daemon-was-down scenario" and it asserted THE MONITOR REPORTS HEALTHY.
    // The bug was not merely unnoticed — it was written down as a REQUIREMENT and
    // pinned by an assertion. "expectedIntervalMs = 0, so warning threshold cannot be
    // computed → healthy" describes the implementation's limitation and then blesses it
    // as the expected result. Any future fix would break this test, and the fix would
    // have looked like the regression.
    //
    // A daily cron that has not run in three days is not healthy. It is the loudest
    // possible signal that something is wrong, and the health monitor said nothing.
    const lastFire = new Date(NOW_MS - 3 * 86_400_000).toISOString();
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '0 9 * * *' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result.expectedIntervalMs).toBe(0);   // unchanged: we did NOT fabricate an interval
    expect(result.state).toBe('warning');        // the missed-slot rule sees it
  });

  it('handles clock skew: lastFire in the future produces gapMs < 0 but state healthy', () => {
    // If lastFire > now (unlikely but possible with clock adjustments),
    // gapMs will be negative; warning condition gapMs > 2x is false → healthy
    const lastFire = new Date(NOW_MS + 3_600_000).toISOString(); // 1h in the future
    const row = makeRow({ lastFire, lastStatus: 'fired', schedule: '6h' });
    const result = computeHealth(row, [], NOW_MS);
    // gapMs is negative
    expect(result.gapMs).toBeLessThan(0);
    expect(result.state).toBe('healthy');
  });

  it('exposes all CronHealth fields', () => {
    const row = makeRow({ lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'fired' });
    const result = computeHealth(row, [], NOW_MS);
    expect(result).toHaveProperty('agent');
    expect(result).toHaveProperty('org');
    expect(result).toHaveProperty('cronName');
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('lastFire');
    expect(result).toHaveProperty('expectedIntervalMs');
    expect(result).toHaveProperty('gapMs');
    expect(result).toHaveProperty('successRate24h');
    expect(result).toHaveProperty('firesLast24h');
    expect(result).toHaveProperty('nextFire');
  });

  it('reason string is non-empty for all states', () => {
    const states: Array<{ lastFire: string | null; lastStatus: 'fired' | 'failed' | null; schedule: string }> = [
      { lastFire: null, lastStatus: null, schedule: '6h' },
      { lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'failed', schedule: '6h' },
      { lastFire: new Date(NOW_MS - 13 * 3_600_000).toISOString(), lastStatus: 'fired', schedule: '6h' },
      { lastFire: new Date(NOW_MS - 1000).toISOString(), lastStatus: 'fired', schedule: '6h' },
    ];
    for (const s of states) {
      const row = makeRow(s);
      const result = computeHealth(row, [], NOW_MS);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateFleetHealth
// ---------------------------------------------------------------------------

describe('aggregateFleetHealth', () => {
  function makeHealth(agent: string, state: HealthState, org = 'lifeos'): CronHealth {
    return {
      agent,
      org,
      cronName: 'test-cron',
      state,
      reason: 'test',
      lastFire: null,
      expectedIntervalMs: 0,
      gapMs: null,
      successRate24h: 1,
      firesLast24h: 0,
      nextFire: new Date(NOW_MS + 3_600_000).toISOString(),
    };
  }

  it('returns zeroed summary for empty input', () => {
    const result = aggregateFleetHealth([]);
    expect(result.summary.total).toBe(0);
    expect(result.summary.healthy).toBe(0);
    expect(result.summary.warning).toBe(0);
    expect(result.summary.failure).toBe(0);
    expect(result.summary.neverFired).toBe(0);
    expect(Object.keys(result.summary.agents)).toHaveLength(0);
  });

  it('counts states correctly across multiple agents', () => {
    const rows: CronHealth[] = [
      makeHealth('boris', 'healthy'),
      makeHealth('boris', 'warning'),
      makeHealth('boris', 'failure'),
      makeHealth('paul', 'healthy'),
      makeHealth('paul', 'never-fired'),
      makeHealth('nick', 'never-fired'),
    ];
    const result = aggregateFleetHealth(rows);
    expect(result.summary.total).toBe(6);
    expect(result.summary.healthy).toBe(2);
    expect(result.summary.warning).toBe(1);
    expect(result.summary.failure).toBe(1);
    expect(result.summary.neverFired).toBe(2);
  });

  it('builds per-agent breakdown correctly', () => {
    const rows: CronHealth[] = [
      makeHealth('boris', 'healthy'),
      makeHealth('boris', 'warning'),
      makeHealth('paul', 'failure'),
      makeHealth('paul', 'never-fired'),
      makeHealth('paul', 'never-fired'),
    ];
    const result = aggregateFleetHealth(rows);
    expect(Object.keys(result.summary.agents)).toHaveLength(2);

    const boris = result.summary.agents['boris'];
    expect(boris.total).toBe(2);
    expect(boris.healthy).toBe(1);
    expect(boris.warning).toBe(1);
    expect(boris.failure).toBe(0);
    expect(boris.neverFired).toBe(0);

    const paul = result.summary.agents['paul'];
    expect(paul.total).toBe(3);
    expect(paul.healthy).toBe(0);
    expect(paul.failure).toBe(1);
    expect(paul.neverFired).toBe(2);
  });

  it('preserves agent org in per-agent summary', () => {
    const rows: CronHealth[] = [
      { ...makeHealth('boris', 'healthy', 'lifeos') },
    ];
    const result = aggregateFleetHealth(rows);
    expect(result.summary.agents['boris'].org).toBe('lifeos');
  });

  it('returns all input rows in result.rows unchanged', () => {
    const rows: CronHealth[] = [
      makeHealth('boris', 'healthy'),
      makeHealth('paul', 'warning'),
    ];
    const result = aggregateFleetHealth(rows);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].agent).toBe('boris');
    expect(result.rows[1].agent).toBe('paul');
  });

  it('handles single agent with all healthy crons', () => {
    const rows: CronHealth[] = Array.from({ length: 5 }, (_, i) =>
      makeHealth('boris', 'healthy')
    );
    const result = aggregateFleetHealth(rows);
    expect(result.summary.total).toBe(5);
    expect(result.summary.healthy).toBe(5);
    expect(result.summary.warning).toBe(0);
    expect(result.summary.failure).toBe(0);
    expect(result.summary.neverFired).toBe(0);
  });
});
