/**
 * tests/unit/dashboard/cron-utils-validation.test.ts — Subtask 4.2
 *
 * Tests for the new form-validation helpers added to dashboard/src/lib/cron-utils.ts:
 *   - isValidScheduleClient
 *   - isValidCronName
 *   - scheduleExamples
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// isValidScheduleClient
// ---------------------------------------------------------------------------

describe('isValidScheduleClient', () => {
  it('accepts standard interval shorthands', async () => {
    const { isValidScheduleClient } = await import(
      '../../../dashboard/src/lib/cron-utils.js'
    );
    for (const s of ['1m', '5m', '30m', '1h', '6h', '24h', '1d', '7d', '1w', '2w']) {
      expect(isValidScheduleClient(s), s).toBe(true);
    }
  });

  it('accepts valid 5-field cron expressions', async () => {
    const { isValidScheduleClient } = await import(
      '../../../dashboard/src/lib/cron-utils.js'
    );
    for (const s of [
      '0 9 * * *',
      '*/15 * * * *',
      '0 0,6,12,18 * * *',
      '30 14 * * 1-5',
      '0 16 * * 1',
    ]) {
      expect(isValidScheduleClient(s), s).toBe(true);
    }
  });

  it('rejects invalid strings', async () => {
    const { isValidScheduleClient } = await import(
      '../../../dashboard/src/lib/cron-utils.js'
    );
    for (const s of ['', '   ', 'abc', '6 hours', 'every day', '* * *', '0 9']) {
      expect(isValidScheduleClient(s), s).toBe(false);
    }
  });

  it('rejects out-of-range cron field values', async () => {
    const { isValidScheduleClient } = await import(
      '../../../dashboard/src/lib/cron-utils.js'
    );
    expect(isValidScheduleClient('60 9 * * *')).toBe(false); // minute 60 invalid
    expect(isValidScheduleClient('0 25 * * *')).toBe(false); // hour 25 invalid
  });
});

// ---------------------------------------------------------------------------
// isValidCronName
// ---------------------------------------------------------------------------

describe('isValidCronName', () => {
  it('accepts valid names', async () => {
    const { isValidCronName } = await import('../../../dashboard/src/lib/cron-utils.js');
    for (const n of ['heartbeat', 'daily-report', 'morning_briefing', 'cron123', 'A-B']) {
      expect(isValidCronName(n), n).toBe(true);
    }
  });

  it('rejects empty string', async () => {
    const { isValidCronName } = await import('../../../dashboard/src/lib/cron-utils.js');
    expect(isValidCronName('')).toBe(false);
  });

  it('rejects names with spaces', async () => {
    const { isValidCronName } = await import('../../../dashboard/src/lib/cron-utils.js');
    expect(isValidCronName('has space')).toBe(false);
    expect(isValidCronName('has\ttab')).toBe(false);
  });

  it('rejects names with special characters', async () => {
    const { isValidCronName } = await import('../../../dashboard/src/lib/cron-utils.js');
    expect(isValidCronName('foo.bar')).toBe(false);
    expect(isValidCronName('foo/bar')).toBe(false);
    expect(isValidCronName('foo@bar')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scheduleExamples
// ---------------------------------------------------------------------------

describe('scheduleExamples', () => {
  it('returns an array of example objects with value and label', async () => {
    const { scheduleExamples } = await import('../../../dashboard/src/lib/cron-utils.js');
    const examples = scheduleExamples();
    expect(Array.isArray(examples)).toBe(true);
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(typeof ex.value).toBe('string');
      expect(typeof ex.label).toBe('string');
      expect(ex.value.length).toBeGreaterThan(0);
      expect(ex.label.length).toBeGreaterThan(0);
    }
  });

  it('all example values are valid schedules', async () => {
    const { scheduleExamples, isValidScheduleClient } = await import(
      '../../../dashboard/src/lib/cron-utils.js'
    );
    const examples = scheduleExamples();
    for (const ex of examples) {
      expect(isValidScheduleClient(ex.value), `${ex.value} should be valid`).toBe(true);
    }
  });
});
