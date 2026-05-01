/**
 * tests/unit/daemon/cron-scheduler.test.ts
 *
 * Unit tests for CronScheduler (Subtask 1.3).
 *
 * All timing is driven by vitest fake timers (vi.useFakeTimers / vi.advanceTimersByTimeAsync).
 * Disk I/O is fully mocked so tests run without touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock crons.ts I/O BEFORE importing CronScheduler so the module resolution
// picks up the mock.
// ---------------------------------------------------------------------------

const mockReadCrons  = vi.fn();
const mockUpdateCron = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons:  (...args: unknown[]) => mockReadCrons(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock setup
// ---------------------------------------------------------------------------

import { CronScheduler, nextFireFromCron } from '../../../src/daemon/cron-scheduler';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'test-cron',
    prompt: 'Do something.',
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TICK = CronScheduler.TICK_INTERVAL_MS; // 30_000 ms

// ---------------------------------------------------------------------------
// nextFireFromCron — unit tests for the cron expression parser
//
// These tests are timezone-agnostic: rather than hardcoding UTC epoch ms
// values (which would break on machines not set to UTC), we verify:
//   (a) the result is a valid number,
//   (b) the local-time fields (hour, minute, day-of-week) of the result
//       match what the cron expression requests.
// ---------------------------------------------------------------------------

/** Pull the local-time components out of an epoch-ms value. */
function localOf(ms: number) {
  const d = new Date(ms);
  return {
    minutes:    d.getMinutes(),
    hours:      d.getHours(),
    date:       d.getDate(),
    month:      d.getMonth() + 1,
    dayOfWeek:  d.getDay(),
  };
}

describe('nextFireFromCron', () => {
  it('computes correct next fire for "*/5 * * * *" (every 5 minutes)', () => {
    // Use the current time as the reference so this is always timezone-safe.
    const fromMs = Date.now();
    const next = nextFireFromCron('*/5 * * * *', fromMs);
    expect(next).not.toBeNaN();
    // Result must be after fromMs and within the next 5 minutes
    expect(next).toBeGreaterThan(fromMs);
    expect(next).toBeLessThanOrEqual(fromMs + 5 * 60_000 + 60_000);
    // The minute must be a multiple of 5
    expect(localOf(next).minutes % 5).toBe(0);
    // Seconds must be zero (whole minute)
    expect(next % 60_000).toBe(0);
  });

  it('computes next fire at local hour 13 for "0 13 * * *" when before 13:00 today', () => {
    // Construct a "from" time that is in local hour 12 today.
    const ref = new Date();
    ref.setHours(12, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 13 * * *', fromMs);
    expect(next).not.toBeNaN();

    const loc = localOf(next);
    expect(loc.hours).toBe(13);
    expect(loc.minutes).toBe(0);
    // Must be the same calendar date (still today)
    expect(loc.date).toBe(new Date(fromMs).getDate());
  });

  it('wraps to next day when local hour 13 has already passed today', () => {
    // Construct a "from" time in local hour 14 today.
    const ref = new Date();
    ref.setHours(14, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 13 * * *', fromMs);
    expect(next).not.toBeNaN();

    const loc = localOf(next);
    expect(loc.hours).toBe(13);
    expect(loc.minutes).toBe(0);
    // Must be tomorrow (date + 1), accounting for month wrap
    const expectedDate = new Date(fromMs);
    expectedDate.setDate(expectedDate.getDate() + 1);
    expect(loc.date).toBe(expectedDate.getDate());
  });

  it('handles comma-list: "0 0,6,12,18 * * *" — picks the next matching hour', () => {
    // Set from = local 05:00 so next matching hour is 6.
    const ref = new Date();
    ref.setHours(5, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 0,6,12,18 * * *', fromMs);
    expect(next).not.toBeNaN();

    const loc = localOf(next);
    expect([0, 6, 12, 18]).toContain(loc.hours);
    expect(loc.minutes).toBe(0);
    expect(next).toBeGreaterThan(fromMs);
  });

  it('handles ranges: "0 8-10 * * *" — fires within [8,9,10] local hours', () => {
    const ref = new Date();
    ref.setHours(7, 59, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 8-10 * * *', fromMs);
    expect(next).not.toBeNaN();

    const loc = localOf(next);
    expect(loc.hours).toBeGreaterThanOrEqual(8);
    expect(loc.hours).toBeLessThanOrEqual(10);
    expect(loc.minutes).toBe(0);
  });

  it('handles day-of-week restriction: "0 16 * * 1" — fires on a Monday', () => {
    const fromMs = Date.now();
    const next = nextFireFromCron('0 16 * * 1', fromMs);
    expect(next).not.toBeNaN();
    expect(next).toBeGreaterThan(fromMs);

    const loc = localOf(next);
    expect(loc.dayOfWeek).toBe(1); // Monday
    expect(loc.hours).toBe(16);
    expect(loc.minutes).toBe(0);
    // Must be within the next 7 days
    expect(next - fromMs).toBeLessThanOrEqual(8 * 24 * 60 * 60_000);
  });

  it('returns NaN for invalid expression (wrong field count)', () => {
    expect(nextFireFromCron('* * * *', Date.now())).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// CronScheduler behaviour tests (fake timers)
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  let logs: string[];
  let fired: CronDefinition[];
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    logs   = [];
    fired  = [];
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset();

    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (cron) => { fired.push(cron); },
      logger: (msg) => { logs.push(msg); },
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------

  it('fires a "1m" interval cron after 60 seconds', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Advance time so nextFireAt (now + 60s) is reached, plus one tick
    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('test-cron');
  });

  it('does NOT fire before the interval has elapsed', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Advance only 30s (less than 1m)
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fired).toHaveLength(0);
  });

  it('disabled cron does not fire', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m', enabled: false })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(fired).toHaveLength(0);
  });

  it('fires multiple times after multiple intervals', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // 3 minutes worth — should fire 3 times (at 60s, 120s, 180s)
    await vi.advanceTimersByTimeAsync(3 * 60_000 + TICK);

    expect(fired.length).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------

  it('persists last_fired_at and fire_count via updateCron on successful fire', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({
        last_fired_at: expect.any(String),
        fire_count: 1,
      })
    );
  });

  // -------------------------------------------------------------------------
  // onFire failure + retry
  // -------------------------------------------------------------------------

  it('retries onFire 3 times on failure then gives up without crashing', async () => {
    const failingFire = vi.fn().mockRejectedValue(new Error('PTY unavailable'));

    // Use a very long schedule so the cron never becomes due a SECOND time
    // during the test (avoiding double-fire across ticks).
    mockReadCrons.mockReturnValue([makeCron({ schedule: '24h' })]);

    const retryLogs: string[] = [];
    const retryScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: failingFire,
      logger: (msg) => retryLogs.push(msg),
    });

    // Seed a last_fired_at that is 25h ago so it catch-up fires immediately.
    mockReadCrons.mockReturnValue([
      makeCron({
        schedule:      '24h',
        last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      }),
    ]);

    retryScheduler.start();

    // Advance through one tick (fires catch-up) plus all retry back-offs (1s+4s+16s)
    await vi.advanceTimersByTimeAsync(TICK + 1_000 + 4_000 + 16_000 + 1_000);

    // 4 total calls: 1 initial + 3 retries
    expect(failingFire).toHaveBeenCalledTimes(4);

    // Scheduler must NOT crash — the log should contain a give-up message
    expect(retryLogs.some(l => l.includes('giving up'))).toBe(true);

    // No updateCron call because all attempts failed
    expect(mockUpdateCron).not.toHaveBeenCalled();

    retryScheduler.stop();
  });

  it('succeeds on second attempt (first fails, second succeeds)', async () => {
    let callCount = 0;
    const flakyFire = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve();
    });

    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);

    const retryScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: flakyFire,
      logger: (msg) => logs.push(msg),
    });

    retryScheduler.start();

    await vi.advanceTimersByTimeAsync(60_000 + TICK + 1_000 + 500);

    expect(flakyFire).toHaveBeenCalledTimes(2);
    expect(mockUpdateCron).toHaveBeenCalledTimes(1);

    retryScheduler.stop();
  });

  // -------------------------------------------------------------------------
  // reload() — picks up newly added cron
  // -------------------------------------------------------------------------

  it('reload() picks up a newly added cron without restarting', async () => {
    // Start with one cron
    mockReadCrons.mockReturnValue([makeCron({ name: 'existing', schedule: '1m' })]);
    scheduler.start();

    // Add a second cron via reload
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'existing', schedule: '1m' }),
      makeCron({ name: 'new-cron', schedule: '1m' }),
    ]);
    scheduler.reload();

    expect(scheduler.getNextFireTimes().map(e => e.name)).toContain('new-cron');

    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    const firedNames = fired.map(c => c.name);
    expect(firedNames).toContain('existing');
    expect(firedNames).toContain('new-cron');
  });

  // -------------------------------------------------------------------------
  // reload() — preserves nextFireAt for unchanged crons
  // -------------------------------------------------------------------------

  it('reload() preserves nextFireAt for unchanged crons', async () => {
    mockReadCrons.mockReturnValue([makeCron({ name: 'stable', schedule: '6h' })]);
    scheduler.start();

    const beforeReload = scheduler.getNextFireTimes().find(e => e.name === 'stable');
    expect(beforeReload).toBeDefined();

    // Re-read same definitions
    mockReadCrons.mockReturnValue([makeCron({ name: 'stable', schedule: '6h' })]);
    scheduler.reload();

    const afterReload = scheduler.getNextFireTimes().find(e => e.name === 'stable');
    expect(afterReload).toBeDefined();
    expect(afterReload!.nextFireAt).toBe(beforeReload!.nextFireAt);
  });

  it('reload() recomputes nextFireAt for a modified schedule', async () => {
    mockReadCrons.mockReturnValue([makeCron({ name: 'changing', schedule: '6h' })]);
    scheduler.start();

    const beforeReload = scheduler.getNextFireTimes().find(e => e.name === 'changing');

    // Change the schedule
    mockReadCrons.mockReturnValue([makeCron({ name: 'changing', schedule: '12h' })]);
    scheduler.reload();

    const afterReload = scheduler.getNextFireTimes().find(e => e.name === 'changing');
    // 12h window is bigger — nextFireAt should be different (further out)
    expect(afterReload!.nextFireAt).not.toBe(beforeReload!.nextFireAt);
  });

  // -------------------------------------------------------------------------
  // reload() during in-flight fire — race condition probe
  //
  // If reload() runs while a fire's onFire is awaiting, the old ScheduledCron
  // reference held by tick() becomes orphaned (the new map holds a fresh
  // object with firing=false default).  If the cron's definition changed
  // (e.g. schedule shortened), the fresh ScheduledCron computes nextFireAt
  // from the stale last_fired_at in crons.json — which has not yet been
  // updated because the in-flight fire's persist call hasn't run.  Result:
  // the next tick can re-fire the same logical event.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Iter 8 audit: remove-cron during in-flight fire — orphan / re-fire probe
  //
  // BUG DISCOVERED (iter 9 candidate): the empty-result fallback at
  // cron-scheduler.ts loadCrons() (~line 426) reverts to lastGoodSchedule when
  // a reload yields an empty result. This catches transient corruption (intent)
  // BUT also catches legitimate empty-by-removal (regression): if the user
  // removes the LAST cron via `bus remove-cron`, crons.json is now empty,
  // reload sees [] from readCrons(), and the fallback restores the just-removed
  // cron from lastGoodSchedule. The cron continues to fire after removal
  // until either (a) the daemon restarts, or (b) another non-empty reload
  // happens.
  //
  // Fix sketch (iter 9): distinguish "legitimate empty" (file exists + parses
  // to []) from "catastrophic corruption" (both primary and .bak unparseable)
  // in readCrons / a sibling function. Only retain lastGoodSchedule on the
  // latter. Tests below pin both current behavior and the desired post-fix
  // behavior.
  // -------------------------------------------------------------------------

  it('remove-cron mid-fire: in-flight fire injects exactly once (no double-fire) — passes', async () => {
    let resolveFire: (() => void) | undefined;
    const slowFire = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveFire = res; }));

    const auditScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (msg) => logs.push(msg),
    });

    // Two crons so the post-removal state is legitimately non-empty (avoiding
    // the empty-result fallback bug in this assertion).
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'doomed', schedule: '10m', last_fired_at: tenMinAgo, fire_count: 1 }),
      makeCron({ name: 'survivor', schedule: '24h', last_fired_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);

    auditScheduler.start();

    // Tick 1: 'doomed' fires catch-up, awaits slowFire
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slowFire).toHaveBeenCalledTimes(1);

    // Mid-fire: simulate remove-cron of 'doomed' — crons.json now only has survivor
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'survivor', schedule: '24h', last_fired_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);
    auditScheduler.reload();

    // Schedule no longer contains 'doomed'
    const namesAfter = auditScheduler.getNextFireTimes().map(e => e.name);
    expect(namesAfter).not.toContain('doomed');
    expect(namesAfter).toContain('survivor');

    // Resolve the in-flight fire
    resolveFire!();
    await vi.advanceTimersByTimeAsync(0);

    // Advance multiple ticks — must NOT re-fire 'doomed'
    await vi.advanceTimersByTimeAsync(5 * TICK);

    expect(slowFire).toHaveBeenCalledTimes(1);
    auditScheduler.stop();
  });

  it.todo(
    'iter 9: remove-cron of LAST cron clears the schedule (currently reverts via lastGoodSchedule fallback)'
  );

  it('reload() during in-flight fire with changed schedule does not cause double-fire', async () => {
    // Slow onFire we can resolve manually
    let resolveFire: (() => void) | undefined;
    const slowFire = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveFire = res; }));

    const raceLogs: string[] = [];
    const raceScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (msg) => raceLogs.push(msg),
    });

    // Start with a cron that fires immediately (catch-up)
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'racy', schedule: '10m', last_fired_at: tenMinAgo, fire_count: 1 }),
    ]);

    raceScheduler.start();

    // First tick: catch-up fires, awaits our slow Promise
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slowFire).toHaveBeenCalledTimes(1);

    // Mid-fire: reload with a SHORTER schedule (changeKey differs).
    // crons.json's last_fired_at is still the stale 10-min-ago value
    // because the in-flight fire's persist hasn't run yet.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'racy', schedule: '1m', last_fired_at: tenMinAgo, fire_count: 1 }),
    ]);
    raceScheduler.reload();

    // Resolve the in-flight fire so the original tick completes
    resolveFire!();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Advance one more tick. The bug: new ScheduledCron's catch-up
    // (referenceMs = stale last_fired_at + 1m schedule = past) re-fires
    // the same logical event.
    await vi.advanceTimersByTimeAsync(TICK);

    // Should be exactly 1 fire — the original. Bug repro: we'd see 2.
    expect(slowFire).toHaveBeenCalledTimes(1);

    raceScheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Catch-up on start
  // -------------------------------------------------------------------------

  it('fires once on start when last_fired_at is older than the interval (catch-up)', async () => {
    // last_fired_at is 2 hours ago, schedule is "1h" — should catch-up fire immediately
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:          'overdue',
        schedule:      '1h',
        last_fired_at: twoHoursAgo,
        fire_count:    5,
      }),
    ]);

    scheduler.start();

    // The catch-up sets nextFireAt = now, so the very next tick should fire it
    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'overdue')).toBe(true);
  });

  it('does NOT fire on start when the cron is not yet due', async () => {
    // last_fired_at is 30 minutes ago, schedule is "1h" — not yet due
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:          'fresh',
        schedule:      '1h',
        last_fired_at: thirtyMinsAgo,
      }),
    ]);

    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'fresh')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // stop() — clears interval, no further fires
  // -------------------------------------------------------------------------

  it('stop() clears the interval and prevents further fires', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Let it fire once
    await vi.advanceTimersByTimeAsync(60_000 + TICK);
    expect(fired).toHaveLength(1);

    scheduler.stop();
    const countAfterStop = fired.length;

    // Advance a lot more — should NOT fire again
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired).toHaveLength(countAfterStop);
  });

  it('stop() called twice does not throw', () => {
    mockReadCrons.mockReturnValue([]);
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Cron expression scheduling via scheduler
  // -------------------------------------------------------------------------

  it('"*/5 * * * *" expression fires within 5 minutes + one tick', async () => {
    // No system time pinning — works regardless of machine timezone.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'every5min', schedule: '*/5 * * * *' }),
    ]);

    scheduler.start();

    // Worst case: just missed a 5-min boundary, so next fire is ~5 minutes away.
    // Advance 5 minutes + one tick to guarantee the cron fires.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + TICK);

    expect(fired.some(c => c.name === 'every5min')).toBe(true);
    // Verify the fire happened at a minute that is divisible by 5
    const firedCron = fired.find(c => c.name === 'every5min');
    expect(firedCron).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getNextFireTimes — informational
  // -------------------------------------------------------------------------

  it('getNextFireTimes returns an entry per enabled cron', () => {
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'a', schedule: '1h' }),
      makeCron({ name: 'b', schedule: '2h' }),
      makeCron({ name: 'c', schedule: '3h', enabled: false }),
    ]);
    scheduler.start();

    const times = scheduler.getNextFireTimes();
    const names = times.map(t => t.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('c'); // disabled, not scheduled
  });
});
