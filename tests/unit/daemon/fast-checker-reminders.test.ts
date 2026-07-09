import { describe, it, expect } from 'vitest';
import { selectDueReminders, REMINDER_REINJECT_MS } from '../../../src/daemon/fast-checker';
import type { Reminder } from '../../../src/bus/reminders';

function reminder(id: string, fireAt: string = '2026-07-08T00:00:00.000Z'): Reminder {
  return {
    id,
    created_at: '2026-07-07T00:00:00.000Z',
    fire_at: fireAt,
    prompt: `prompt for ${id}`,
    status: 'pending',
  };
}

describe('selectDueReminders (live-session reminder delivery)', () => {
  const now = 1_000_000_000_000;

  it('selects a reminder that has never been injected', () => {
    const due = [reminder('r1')];
    const picked = selectDueReminders(due, new Map(), now);
    expect(picked.map(r => r.id)).toEqual(['r1']);
  });

  it('throttles a reminder injected within the re-inject window', () => {
    const due = [reminder('r1')];
    const last = new Map([['r1', now - REMINDER_REINJECT_MS + 1]]);
    expect(selectDueReminders(due, last, now)).toEqual([]);
  });

  it('re-selects once the re-inject window has elapsed', () => {
    const due = [reminder('r1')];
    const last = new Map([['r1', now - REMINDER_REINJECT_MS]]);
    expect(selectDueReminders(due, last, now).map(r => r.id)).toEqual(['r1']);
  });

  it('handles a mix of fresh, throttled, and window-elapsed reminders', () => {
    const due = [reminder('fresh'), reminder('throttled'), reminder('elapsed')];
    const last = new Map([
      ['throttled', now - 1000],
      ['elapsed', now - REMINDER_REINJECT_MS - 1],
    ]);
    expect(selectDueReminders(due, last, now).map(r => r.id)).toEqual(['fresh', 'elapsed']);
  });

  it('respects a custom re-inject window', () => {
    const due = [reminder('r1')];
    const last = new Map([['r1', now - 30_000]]);
    expect(selectDueReminders(due, last, now, 60_000)).toEqual([]);
    expect(selectDueReminders(due, last, now, 30_000).map(r => r.id)).toEqual(['r1']);
  });

  it('returns nothing when no reminders are due', () => {
    expect(selectDueReminders([], new Map(), now)).toEqual([]);
  });
});
