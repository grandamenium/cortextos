import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs, cronExpressionMinIntervalMs } from '../../../src/bus/cron-state';

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

describe('cronExpressionMinIntervalMs', () => {
  const DAY_MS = 24 * 3_600_000;

  it('returns per-minute interval for */N * * * *', () => {
    expect(cronExpressionMinIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
    expect(cronExpressionMinIntervalMs('*/15 * * * *')).toBe(15 * 60_000);
  });

  it('returns per-hour interval for fixed-minute */N * * *', () => {
    expect(cronExpressionMinIntervalMs('0 */4 * * *')).toBe(4 * 3_600_000);
    expect(cronExpressionMinIntervalMs('30 */6 * * *')).toBe(6 * 3_600_000);
  });

  it('returns daily (24h) for fixed-hour daily expression', () => {
    expect(cronExpressionMinIntervalMs('0 8 * * *')).toBe(DAY_MS);
    expect(cronExpressionMinIntervalMs('30 6 * * *')).toBe(DAY_MS);
  });

  it('returns weekly (7d) for fixed-hour with specific weekday', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * 1')).toBe(7 * DAY_MS);
    expect(cronExpressionMinIntervalMs('50 6 * * 1')).toBe(7 * DAY_MS);
  });

  it('returns monthly (30d) for fixed-hour with specific dom', () => {
    expect(cronExpressionMinIntervalMs('0 9 1 * *')).toBe(30 * DAY_MS);
    expect(cronExpressionMinIntervalMs('0 15 20 * *')).toBe(30 * DAY_MS);
  });

  it('returns yearly (365d) for fixed-hour with specific dom AND month — defect 2 regression', () => {
    // "0 15 18 7 *" is denny-due-reminder: Jul 18 at 15:00 UTC. Previously
    // returned 24h (wrong) causing any >24h miss to be dropped as stale.
    expect(cronExpressionMinIntervalMs('0 15 18 7 *')).toBe(365 * DAY_MS);
    expect(cronExpressionMinIntervalMs('15 6 16 6 *')).toBe(365 * DAY_MS); // osceola-reminder
    expect(cronExpressionMinIntervalMs('0 15 1 1,7 *')).toBe(365 * DAY_MS);
  });

  it('returns 48h fallback for unrecognised patterns', () => {
    expect(cronExpressionMinIntervalMs('')).toBe(48 * 3_600_000);
    expect(cronExpressionMinIntervalMs('invalid')).toBe(48 * 3_600_000);
  });
});
