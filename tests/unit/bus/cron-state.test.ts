import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs, intervalToCronExpression } from '../../../src/bus/cron-state';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(6 * 3_600_000);
    expect(parseDurationMs('24h')).toBe(24 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('2w')).toBe(2 * 604_800_000);
  });

  it('returns NaN for cron expressions', () => {
    expect(parseDurationMs('0 8 * * *')).toBeNaN();
    expect(parseDurationMs('*/5 * * * *')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseDurationMs('')).toBeNaN();
  });

  it('returns NaN for unknown unit', () => {
    expect(parseDurationMs('5y')).toBeNaN();
    expect(parseDurationMs('10s')).toBeNaN();
  });
});

describe('intervalToCronExpression', () => {
  it('converts sub-hour minute intervals that divide 60', () => {
    expect(intervalToCronExpression('5m')).toBe('*/5 * * * *');
    expect(intervalToCronExpression('15m')).toBe('*/15 * * * *');
    expect(intervalToCronExpression('30m')).toBe('*/30 * * * *');
  });

  it('returns null for minute intervals that do not divide 60 cleanly', () => {
    expect(intervalToCronExpression('7m')).toBeNull();
    expect(intervalToCronExpression('45m')).toBeNull();
  });

  it('converts whole-hour minute intervals when hours divide 24', () => {
    expect(intervalToCronExpression('60m')).toBe('0 */1 * * *');
    expect(intervalToCronExpression('120m')).toBe('0 */2 * * *');
    expect(intervalToCronExpression('240m')).toBe('0 */4 * * *');
  });

  it('returns null for whole-hour minute intervals that do not divide 24', () => {
    expect(intervalToCronExpression('300m')).toBeNull(); // 5 hours doesn't divide 24
    expect(intervalToCronExpression('420m')).toBeNull(); // 7 hours
  });

  it('converts hour intervals that divide 24', () => {
    expect(intervalToCronExpression('1h')).toBe('0 */1 * * *');
    expect(intervalToCronExpression('4h')).toBe('0 */4 * * *');
    expect(intervalToCronExpression('12h')).toBe('0 */12 * * *');
  });

  it('returns null for hour intervals that do not divide 24', () => {
    expect(intervalToCronExpression('5h')).toBeNull();
    expect(intervalToCronExpression('7h')).toBeNull();
    expect(intervalToCronExpression('25h')).toBeNull();
  });

  it('converts day intervals', () => {
    expect(intervalToCronExpression('1d')).toBe('0 0 */1 * *');
    expect(intervalToCronExpression('7d')).toBe('0 0 */7 * *');
  });

  it('converts 1w only', () => {
    expect(intervalToCronExpression('1w')).toBe('0 0 * * 0');
    expect(intervalToCronExpression('2w')).toBeNull();
  });

  it('returns null for malformed or unsupported intervals', () => {
    expect(intervalToCronExpression('')).toBeNull();
    expect(intervalToCronExpression('5y')).toBeNull();
    expect(intervalToCronExpression('abc')).toBeNull();
    expect(intervalToCronExpression('0h')).toBeNull();
    expect(intervalToCronExpression('0 8 * * *')).toBeNull();
  });
});

describe('readCronState', () => {
  it('returns empty state when file does not exist', () => {
    const state = readCronState(tmpDir);
    expect(state.crons).toEqual([]);
    cleanup();
  });
});

describe('updateCronFire', () => {
  it('creates a record when none exists', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('6h');
    expect(Date.parse(state.crons[0].last_fire)).not.toBeNaN();
    cleanup();
  });

  it('updates existing record for the same cron name', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const first = readCronState(tmpDir).crons[0].last_fire;

    // Ensure time advances
    const before = Date.now();
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const second = readCronState(tmpDir).crons[0].last_fire;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(before);
    expect(readCronState(tmpDir).crons).toHaveLength(1); // no duplicate
    cleanup();
  });

  it('accumulates records for different cron names', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(2);
    const names = state.crons.map(r => r.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('autoresearch');
    cleanup();
  });

  it('works without interval argument', () => {
    updateCronFire(tmpDir, 'heartbeat');
    const state = readCronState(tmpDir);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBeUndefined();
    cleanup();
  });

  it('survives a read-write-read cycle with correct values', () => {
    updateCronFire(tmpDir, 'inbox-triage', '2h');
    updateCronFire(tmpDir, 'heartbeat', '4h');
    const state = readCronState(tmpDir);
    const inbox = state.crons.find(r => r.name === 'inbox-triage');
    const hb = state.crons.find(r => r.name === 'heartbeat');
    expect(inbox?.interval).toBe('2h');
    expect(hb?.interval).toBe('4h');
    cleanup();
  });
});
