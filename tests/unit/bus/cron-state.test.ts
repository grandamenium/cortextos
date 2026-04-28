import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs, cronExpressionMinIntervalMs } from '../../../src/bus/cron-state';

const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  it('parses every-N-minutes patterns', () => {
    expect(cronExpressionMinIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
    expect(cronExpressionMinIntervalMs('*/30 * * * *')).toBe(30 * 60_000);
  });

  it('parses every-N-hours patterns', () => {
    expect(cronExpressionMinIntervalMs('0 */1 * * *')).toBe(1 * HOUR);
    expect(cronExpressionMinIntervalMs('3 */4 * * *')).toBe(4 * HOUR);
    expect(cronExpressionMinIntervalMs('0 */6 * * *')).toBe(6 * HOUR);
  });

  it('returns 24h for daily fixed-hour patterns', () => {
    expect(cronExpressionMinIntervalMs('0 6 * * *')).toBe(24 * HOUR);
    expect(cronExpressionMinIntervalMs('7 23 * * *')).toBe(24 * HOUR);
    expect(cronExpressionMinIntervalMs('30 0 * * *')).toBe(24 * HOUR);
  });

  describe('day-of-week restrictions (real production case)', () => {
    it('Sunday-only fires once per week (168h)', () => {
      // analyst's catalog-browse: '4 23 * * 0' — was wrongly classified as 24h
      expect(cronExpressionMinIntervalMs('4 23 * * 0')).toBe(7 * DAY);
    });

    it('Friday-only fires once per week', () => {
      // finance's friday_checkin: '7 17 * * 5'
      expect(cronExpressionMinIntervalMs('7 17 * * 5')).toBe(7 * DAY);
    });

    it('weekday range (Mon-Fri) max gap is 3 days (Fri → Mon)', () => {
      expect(cronExpressionMinIntervalMs('0 9 * * 1-5')).toBe(3 * DAY);
    });

    it('comma-separated weekday list picks the largest gap', () => {
      // Mon, Wed, Fri → gaps 2, 2, 3 days → max 3
      expect(cronExpressionMinIntervalMs('0 9 * * 1,3,5')).toBe(3 * DAY);
    });

    it('every-other-day DoW pattern (*/2) max gap is 2 days', () => {
      expect(cronExpressionMinIntervalMs('0 9 * * */2')).toBe(2 * DAY);
    });
  });

  describe('day-of-month restrictions', () => {
    it('every-N-days fires every N days', () => {
      // finance's email_invoice_scan: '23 9 */3 * *'
      expect(cronExpressionMinIntervalMs('23 9 */3 * *')).toBe(3 * DAY);
    });

    it('fixed day-of-month treats max gap as 31 days', () => {
      // finance's monthly_invoice_prep: '17 9 28 * *'
      expect(cronExpressionMinIntervalMs('17 9 28 * *')).toBe(31 * DAY);
    });
  });

  describe('month + day-of-month (yearly cadence)', () => {
    it('quarterly months × fixed day-of-month is yearly-conservative', () => {
      // finance's btw_deadline_tracker: '23 9 20 1,4,7,10 *'
      expect(cronExpressionMinIntervalMs('23 9 20 1,4,7,10 *')).toBe(365 * DAY);
    });

    it('yearly fires once per year', () => {
      // finance's year_end_prep: '43 10 15 11 *'
      expect(cronExpressionMinIntervalMs('43 10 15 11 *')).toBe(365 * DAY);
    });
  });

  describe('fallbacks', () => {
    it('returns 31d on unparseable expression (5 fields but unrecognized shape)', () => {
      expect(cronExpressionMinIntervalMs('* * L * *')).toBe(31 * DAY);
    });

    it('returns 31d on wrong number of fields', () => {
      expect(cronExpressionMinIntervalMs('garbage')).toBe(31 * DAY);
      expect(cronExpressionMinIntervalMs('0 6 *')).toBe(31 * DAY);
    });

    it('returns 7d on malformed DoW range', () => {
      expect(cronExpressionMinIntervalMs('0 9 * * 5-1')).toBe(7 * DAY);
    });
  });
});
