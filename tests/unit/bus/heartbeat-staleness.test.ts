import { describe, it, expect } from 'vitest';
import {
  computeStaleThresholdMs,
  isHeartbeatStale,
  HB_STALE_FALLBACK_MS,
} from '../../../src/bus/heartbeat-staleness';

const MIN = 60_000;
const HOUR = 3_600_000;

describe('computeStaleThresholdMs — per-agent cadence thresholds', () => {
  // Trio case 1: a normal cadence sits in the 3×-band (below the 6h cap, above
  // both floors), so the threshold is simply 3× the expected beat.
  it('normal cadence → 3× the interval', () => {
    const r = computeStaleThresholdMs('1h');
    expect(r.fallback).toBe(false);
    expect(r.thresholdMs).toBe(3 * HOUR);
    expect(computeStaleThresholdMs('30m').thresholdMs).toBe(90 * MIN); // 3×30m
  });

  // Trio case 2: the CAP-BITE GUARD. A cadence at/above the 6h cap must not be
  // flagged at its own normal beat — the 1.5× floor lifts it above the cap.
  it('cadence near/above the 6h cap → 1.5× floor beats the cap (cap-bite guard)', () => {
    // 4h: min(12h,6h)=6h vs 1.5×4h=6h → 6h (exactly at the cap, no bite yet).
    expect(computeStaleThresholdMs('4h').thresholdMs).toBe(6 * HOUR);
    // 6h: min(18h,6h)=6h would flag a 6h-cron at its OWN beat; 1.5×6h=9h wins.
    expect(computeStaleThresholdMs('6h').thresholdMs).toBe(9 * HOUR);
    // 1d: 1.5×24h=36h wins over the 6h cap.
    expect(computeStaleThresholdMs('1d').thresholdMs).toBe(36 * HOUR);
  });

  // Trio case 3: the 15m MIN floor. A very fast cadence can't be flagged stale
  // in under 15m (avoids alert-storms on sub-5-min agents).
  it('very fast cadence → clamped up to the 15m minimum', () => {
    expect(computeStaleThresholdMs('1m').thresholdMs).toBe(15 * MIN); // 3×1m=3m → floor 15m
    expect(computeStaleThresholdMs('5m').thresholdMs).toBe(15 * MIN); // 3×5m=15m → 15m
    expect(computeStaleThresholdMs('6m').thresholdMs).toBe(18 * MIN); // 3×6m=18m > 15m
  });

  it('missing/unparseable interval → 2h fallback flagged', () => {
    for (const bad of [undefined, null, '', '   ', 'garbage', '30s', '0m', '0h', '*/5 * * * *']) {
      const r = computeStaleThresholdMs(bad as string | undefined | null);
      expect(r.fallback).toBe(true);
      expect(r.thresholdMs).toBe(HB_STALE_FALLBACK_MS);
      expect(r.thresholdMs).toBe(2 * HOUR);
    }
  });
});

describe('isHeartbeatStale', () => {
  const now = Date.UTC(2026, 5, 10, 6, 0, 0); // fixed clock

  it('within the per-cadence threshold → not stale', () => {
    const twoHoursAgo = new Date(now - 2 * HOUR).toISOString();
    expect(isHeartbeatStale(twoHoursAgo, '1h', now)).toBe(false); // threshold 3h
  });

  it('older than the per-cadence threshold → stale', () => {
    const fourHoursAgo = new Date(now - 4 * HOUR).toISOString();
    expect(isHeartbeatStale(fourHoursAgo, '1h', now)).toBe(true); // threshold 3h
  });

  it('unparseable timestamp → stale', () => {
    expect(isHeartbeatStale('not-a-date', '1h', now)).toBe(true);
  });
});

describe('paul-regression — the 01:00Z miss the flat-5h watchdog produced', () => {
  const now = Date.UTC(2026, 5, 10, 1, 0, 0); // 01:00Z, when paul read "healthy"
  const OLD_FLAT_THRESHOLD_MS = 5 * HOUR;

  it('paul dead 3.5h with a 1h cadence: per-cadence flags it; the old flat 5h did not', () => {
    const ageMs = 3.5 * HOUR;
    const lastHeartbeat = new Date(now - ageMs).toISOString();

    // Per-cadence threshold for a 1h beat is 3h; 3.5h-dead is past it → STALE.
    const { thresholdMs } = computeStaleThresholdMs('1h');
    expect(thresholdMs).toBe(3 * HOUR);
    expect(isHeartbeatStale(lastHeartbeat, '1h', now)).toBe(true);

    // Regression anchor: the OLD flat 5h watchdog would have read it HEALTHY,
    // because 3.5h < 5h. That is the exact bug this change closes.
    expect(ageMs).toBeLessThan(OLD_FLAT_THRESHOLD_MS);
  });
});
