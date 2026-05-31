import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_STALE_MS,
  HEARTBEAT_UNRESPONSIVE_MS,
  isHeartbeatStale,
  isHeartbeatUnresponsive,
} from '../../../src/bus/heartbeat';

/**
 * Regression tests for the heartbeat staleness thresholds. These exist because
 * the read-all-heartbeats display once hardcoded a 2h [STALE] cutoff while the
 * metrics health check used 5h — a 3h gap that produced false [STALE] alarms
 * for agents that were merely heads-down or idle. Both call sites now share
 * these helpers, so the boundaries are pinned here as the single source of truth.
 */
describe('heartbeat staleness thresholds', () => {
  const NOW = 1_700_000_000_000; // fixed reference instant
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const HOUR = 60 * 60 * 1000;

  it('uses the documented policy values (5h stale, 8h unresponsive)', () => {
    expect(HEARTBEAT_STALE_MS).toBe(5 * HOUR);
    expect(HEARTBEAT_UNRESPONSIVE_MS).toBe(8 * HOUR);
  });

  describe('isHeartbeatStale', () => {
    it('is false for a fresh heartbeat (well under 5h)', () => {
      expect(isHeartbeatStale(ago(1 * HOUR), NOW)).toBe(false);
    });

    it('is false just under the 5h threshold (the old 2h false-alarm window)', () => {
      expect(isHeartbeatStale(ago(2 * HOUR), NOW)).toBe(false);
      expect(isHeartbeatStale(ago(5 * HOUR - 1), NOW)).toBe(false);
    });

    it('is true at or past 5h', () => {
      expect(isHeartbeatStale(ago(5 * HOUR), NOW)).toBe(true);
      expect(isHeartbeatStale(ago(6 * HOUR), NOW)).toBe(true);
    });

    it('treats missing or unparseable timestamps as stale', () => {
      expect(isHeartbeatStale(undefined, NOW)).toBe(true);
      expect(isHeartbeatStale('not-a-date', NOW)).toBe(true);
    });
  });

  describe('isHeartbeatUnresponsive', () => {
    it('is false while merely stale (between 5h and 8h)', () => {
      expect(isHeartbeatUnresponsive(ago(6 * HOUR), NOW)).toBe(false);
      expect(isHeartbeatUnresponsive(ago(8 * HOUR - 1), NOW)).toBe(false);
    });

    it('is true at or past 8h', () => {
      expect(isHeartbeatUnresponsive(ago(8 * HOUR), NOW)).toBe(true);
      expect(isHeartbeatUnresponsive(ago(12 * HOUR), NOW)).toBe(true);
    });

    it('treats missing or unparseable timestamps as unresponsive', () => {
      expect(isHeartbeatUnresponsive(undefined, NOW)).toBe(true);
      expect(isHeartbeatUnresponsive('not-a-date', NOW)).toBe(true);
    });
  });
});
