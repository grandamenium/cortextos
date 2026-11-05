import { describe, it, expect } from 'vitest';
import { isHeartbeatStale, heartbeatStaleThresholdMs } from '../src/bus/heartbeat-staleness.js';

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const M = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('heartbeatStaleThresholdMs', () => {
  it('derives from the agent interval (two missed cycles), with a 1h floor', () => {
    expect(heartbeatStaleThresholdMs('4h')).toBe(8 * H);
    expect(heartbeatStaleThresholdMs('27m')).toBe(H);       // 2*27m=54m -> floored to 1h
    expect(heartbeatStaleThresholdMs('3h')).toBe(6 * H);
  });
  it('falls back to a default when the interval is unknown/unparseable', () => {
    expect(heartbeatStaleThresholdMs('')).toBe(8 * H);        // default 4h base
    expect(heartbeatStaleThresholdMs(null)).toBe(8 * H);
    expect(heartbeatStaleThresholdMs('0 8 * * *')).toBe(8 * H); // cron expr -> NaN -> default
  });
});

describe('isHeartbeatStale', () => {
  it('does NOT flag an agent well inside its interval', () => {
    expect(isHeartbeatStale(ago(1 * H), '4h', NOW)).toBe(false);
  });
  it('does NOT flag a long-interval agent at 3h (the reported false-STALE bug)', () => {
    expect(isHeartbeatStale(ago(3 * H), '4h', NOW)).toBe(false);
  });
  it('DOES flag an agent well past its interval', () => {
    expect(isHeartbeatStale(ago(10 * H), '4h', NOW)).toBe(true);
  });
  it('flags a short-interval agent that missed several ticks', () => {
    expect(isHeartbeatStale(ago(30 * M), '27m', NOW)).toBe(false);
    expect(isHeartbeatStale(ago(90 * M), '27m', NOW)).toBe(true);
  });
  it('treats missing/unparseable timestamps as stale (fail toward not-confirmed-alive)', () => {
    expect(isHeartbeatStale(undefined, '4h', NOW)).toBe(true);
    expect(isHeartbeatStale('not-a-date', '4h', NOW)).toBe(true);
  });
});
