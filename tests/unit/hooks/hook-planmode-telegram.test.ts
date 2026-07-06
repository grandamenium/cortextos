import { describe, expect, it } from 'vitest';
import { resolvePlanDecision } from '../../../src/hooks/hook-planmode-telegram';

describe('resolvePlanDecision', () => {
  it('returns allow for an allow response', () => {
    expect(resolvePlanDecision('{"decision":"allow"}')).toEqual({ decision: 'allow' });
  });

  it('returns deny for a deny response', () => {
    expect(resolvePlanDecision('{"decision":"deny"}')).toEqual({
      decision: 'deny',
      reason: 'Plan denied by user via Telegram. Ask what they want to change.',
    });
  });

  // Regression guard: a present but torn/corrupt response file must never turn
  // a real user deny into an implicit allow.
  it('returns deny for an empty response file', () => {
    expect(resolvePlanDecision('')).toEqual({
      decision: 'deny',
      reason: 'Plan approval response was unreadable — denying for safety. Re-plan.',
    });
  });

  it('returns deny for a partial JSON response file', () => {
    expect(resolvePlanDecision('{"decision":')).toEqual({
      decision: 'deny',
      reason: 'Plan approval response was unreadable — denying for safety. Re-plan.',
    });
  });

  it('returns allow for a genuine timeout', () => {
    expect(resolvePlanDecision(null)).toEqual({ decision: 'allow' });
  });
});
