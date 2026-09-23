import { describe, it, expect, vi } from 'vitest';
import {
  SleepWakeDetector,
  formatDurationShort,
  hhmmUtc,
  type SleepEpisode,
} from '../../../src/daemon/sleep-wake-detector.js';

const MIN = 60_000;
const TICK = 15_000;

/**
 * Drive the detector with a fake clock. `advanceAndTick(ms)` moves the clock
 * forward and runs one tick — exactly what the real interval does, except a
 * host sleep shows up as one tick with a large wall-clock jump.
 */
function makeDetector(opts: { gapThresholdMs?: number; settleTicks?: number } = {}) {
  let nowMs = 1_000_000_000_000;
  const wakes: SleepEpisode[] = [];
  const detector = new SleepWakeDetector({
    onWake: (ep) => wakes.push(ep),
    gapThresholdMs: opts.gapThresholdMs ?? 10 * MIN,
    tickIntervalMs: TICK,
    settleTicks: opts.settleTicks ?? 6,
    now: () => nowMs,
    logger: () => {},
  });
  detector.start();
  detector.stop(); // kill the real interval — we drive tick() manually
  // stop() cleared episode state; re-arm lastTick via start-equivalent:
  // (start() again would re-create the interval, so set the baseline by ticking once)
  detector.tick();
  return {
    detector,
    wakes,
    advanceAndTick(ms: number) {
      nowMs += ms;
      detector.tick();
    },
  };
}

describe('SleepWakeDetector', () => {
  it('emits nothing on a steady tick stream', () => {
    const d = makeDetector();
    for (let i = 0; i < 100; i++) d.advanceAndTick(TICK);
    expect(d.wakes).toHaveLength(0);
  });

  it('ignores gaps below the threshold', () => {
    const d = makeDetector();
    d.advanceAndTick(9 * MIN); // below 10-min threshold
    for (let i = 0; i < 10; i++) d.advanceAndTick(TICK);
    expect(d.wakes).toHaveLength(0);
  });

  it('emits one wake after a single sleep gap + settle', () => {
    const d = makeDetector();
    d.advanceAndTick(TICK);           // steady baseline
    d.advanceAndTick(3 * 60 * MIN);   // 3h sleep
    for (let i = 0; i < 5; i++) d.advanceAndTick(TICK);
    expect(d.wakes).toHaveLength(0);  // settle (6 ticks) not yet complete
    d.advanceAndTick(TICK);           // 6th on-time tick
    expect(d.wakes).toHaveLength(1);
    const ep = d.wakes[0];
    expect(ep.totalSleptMs).toBe(3 * 60 * MIN);
    expect(ep.gapCount).toBe(1);
    expect(ep.wokeAtMs - ep.sleptFromMs).toBe(3 * 60 * MIN);
  });

  it('merges dark-wake interrupted sleep into one episode', () => {
    const d = makeDetector();
    d.advanceAndTick(TICK);
    d.advanceAndTick(60 * MIN);  // sleep 1h
    d.advanceAndTick(TICK);      // dark-wake tick 1
    d.advanceAndTick(TICK);      // dark-wake tick 2 (settle=2 < 6)
    d.advanceAndTick(90 * MIN);  // sleep 1.5h more
    for (let i = 0; i < 6; i++) d.advanceAndTick(TICK); // full wake + settle
    expect(d.wakes).toHaveLength(1);
    const ep = d.wakes[0];
    expect(ep.gapCount).toBe(2);
    expect(ep.totalSleptMs).toBe(150 * MIN); // 1h + 1.5h asleep, dark-wake time excluded
  });

  it('resets the settle counter on each new gap', () => {
    const d = makeDetector({ settleTicks: 3 });
    d.advanceAndTick(20 * MIN);
    d.advanceAndTick(TICK);
    d.advanceAndTick(TICK);       // settle 2/3
    d.advanceAndTick(15 * MIN);   // new gap — settle must restart
    d.advanceAndTick(TICK);
    d.advanceAndTick(TICK);
    expect(d.wakes).toHaveLength(0);
    d.advanceAndTick(TICK);       // settle 3/3
    expect(d.wakes).toHaveLength(1);
    expect(d.wakes[0].gapCount).toBe(2);
  });

  it('reports inSleepAdjacentWindow only while an episode is open', () => {
    const d = makeDetector({ settleTicks: 2 });
    expect(d.detector.inSleepAdjacentWindow()).toBe(false);
    d.advanceAndTick(30 * MIN);
    expect(d.detector.inSleepAdjacentWindow()).toBe(true);
    d.advanceAndTick(TICK);
    d.advanceAndTick(TICK);
    expect(d.detector.inSleepAdjacentWindow()).toBe(false);
    expect(d.wakes).toHaveLength(1);
  });

  it('swallows onWake exceptions without breaking subsequent detection', () => {
    let nowMs = 1_000_000_000_000;
    const wakes: SleepEpisode[] = [];
    let calls = 0;
    const detector = new SleepWakeDetector({
      onWake: (ep) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        wakes.push(ep);
      },
      gapThresholdMs: 10 * MIN,
      settleTicks: 1,
      now: () => nowMs,
      logger: () => {},
    });
    const tick = (ms: number) => { nowMs += ms; detector.tick(); };
    detector.tick(); // baseline
    tick(30 * MIN);
    expect(() => tick(TICK)).not.toThrow(); // settle=1 → onWake throws, swallowed
    tick(45 * MIN);
    tick(TICK);
    expect(calls).toBe(2);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].totalSleptMs).toBe(45 * MIN);
  });

  it('emits separate wakes for separate episodes', () => {
    const d = makeDetector({ settleTicks: 2 });
    d.advanceAndTick(30 * MIN);
    d.advanceAndTick(TICK);
    d.advanceAndTick(TICK);
    d.advanceAndTick(120 * MIN);
    d.advanceAndTick(TICK);
    d.advanceAndTick(TICK);
    expect(d.wakes).toHaveLength(2);
    expect(d.wakes[0].totalSleptMs).toBe(30 * MIN);
    expect(d.wakes[1].totalSleptMs).toBe(120 * MIN);
  });
});

describe('formatDurationShort', () => {
  it('formats seconds, minutes, hours', () => {
    expect(formatDurationShort(45_000)).toBe('45s');
    expect(formatDurationShort(12 * MIN)).toBe('12m');
    expect(formatDurationShort(3 * 60 * MIN + 29 * MIN)).toBe('3h 29m');
    expect(formatDurationShort(2 * 60 * MIN)).toBe('2h');
  });
});

describe('hhmmUtc', () => {
  it('formats epoch ms as zero-padded HH:MM UTC', () => {
    expect(hhmmUtc(Date.UTC(2026, 6, 9, 10, 29))).toBe('10:29');
    expect(hhmmUtc(Date.UTC(2026, 6, 9, 3, 5))).toBe('03:05');
  });
});
