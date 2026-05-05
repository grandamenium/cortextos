import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  CRONS_DIRECTORY,
  CRONS_FILENAME,
  cronsPathFor,
} from '../../../src/bus/crons-schema';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// cronsPathFor — path helper
// ---------------------------------------------------------------------------

describe('cronsPathFor', () => {
  it('returns the expected path for agent "boris"', () => {
    const expected = join('.cortextOS', 'state', 'agents', 'boris', 'crons.json');
    expect(cronsPathFor('boris')).toBe(expected);
  });

  it('uses CRONS_DIRECTORY and CRONS_FILENAME constants', () => {
    const result = cronsPathFor('paul');
    expect(result).toContain(CRONS_DIRECTORY.replace(/\//g, join('/')));
    expect(result.endsWith(CRONS_FILENAME)).toBe(true);
  });

  it('is consistent for any agent name', () => {
    expect(cronsPathFor('sentinel')).toBe(
      join(CRONS_DIRECTORY, 'sentinel', CRONS_FILENAME)
    );
  });

  it('handles agent names with hyphens', () => {
    expect(cronsPathFor('data-agent')).toBe(
      join(CRONS_DIRECTORY, 'data-agent', CRONS_FILENAME)
    );
  });
});

// ---------------------------------------------------------------------------
// CronDefinition compile-time shape test
// ---------------------------------------------------------------------------
//
// These objects are declared as CronDefinition — if any required field is
// absent or has the wrong type, TypeScript will flag a compile error.
// The tests just confirm the objects are accepted by the type system and
// have the expected runtime values.
// ---------------------------------------------------------------------------

describe('CronDefinition — type shape', () => {
  it('accepts a minimal required-fields-only definition', () => {
    const heartbeat: CronDefinition = {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and execute the heartbeat workflow.',
      schedule: '6h',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
    };

    expect(heartbeat.name).toBe('heartbeat');
    expect(heartbeat.schedule).toBe('6h');
    expect(heartbeat.enabled).toBe(true);
    expect(heartbeat.last_fired_at).toBeUndefined();
    expect(heartbeat.fire_count).toBeUndefined();
  });

  it('accepts a full definition with all optional fields', () => {
    const briefing: CronDefinition = {
      name: 'morning-briefing',
      prompt: 'Prepare and send the morning briefing to James.',
      schedule: '0 13 * * *',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
      description: 'Daily 09:00 ET briefing (UTC offset applied in schedule).',
      last_fired_at: '2026-04-28T13:00:01.042Z',
      fire_count: 14,
      metadata: { priority: 'high', source: '/loop' },
    };

    expect(briefing.name).toBe('morning-briefing');
    expect(briefing.schedule).toBe('0 13 * * *');
    expect(briefing.fire_count).toBe(14);
    expect(briefing.last_fired_at).toBe('2026-04-28T13:00:01.042Z');
    expect(briefing.metadata?.['source']).toBe('/loop');
  });

  it('accepts a weekly cron with day-of-week expression', () => {
    const weekly: CronDefinition = {
      name: 'weekly-report',
      prompt: 'Compile and send the weekly performance report.',
      schedule: '0 16 * * 1',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
      description: 'Every Monday at 12:00 ET (16:00 UTC).',
      fire_count: 3,
    };

    expect(weekly.name).toBe('weekly-report');
    expect(weekly.schedule).toBe('0 16 * * 1');
    expect(weekly.enabled).toBe(true);
  });

  it('accepts enabled: false (disabled cron)', () => {
    const paused: CronDefinition = {
      name: 'paused-task',
      prompt: 'This cron is temporarily disabled.',
      schedule: '30m',
      enabled: false,
      created_at: '2026-04-01T00:00:00.000Z',
    };

    expect(paused.enabled).toBe(false);
  });
});
