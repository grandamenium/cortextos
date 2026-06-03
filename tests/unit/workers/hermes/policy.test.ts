import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHAIN,
  DEFAULT_MAX_TOTAL_MS,
  backoffMs,
  maxRetries,
  order,
} from '../../../../src/workers/hermes/policy';

/**
 * SECONDARY L3 unit coverage for the pure policy layer (spec §6.3). No mocks —
 * policy.ts is side-effect-free data + thin functions, so these pin the EXACT
 * decision table (order, retry caps, backoff schedule, budget constant).
 */

describe('order() — preferred hoist (spec §6.3)', () => {
  it('default (no preferred) returns the strategic chain', () => {
    expect(order()).toEqual(['codex', 'gemini', 'claude']);
  });

  it('preferred gemini hoists it to index 0, rest in original relative order', () => {
    expect(order('gemini')).toEqual(['gemini', 'codex', 'claude']);
  });

  it('preferred claude hoists it to index 0', () => {
    expect(order('claude')).toEqual(['claude', 'codex', 'gemini']);
  });

  it('undefined returns the default chain unchanged', () => {
    expect(order(undefined)).toEqual(['codex', 'gemini', 'claude']);
  });

  it('a preferred not in the chain returns the default chain unchanged', () => {
    // 'bogus' is not a member of DEFAULT_CHAIN.
    expect(order('bogus' as never)).toEqual(['codex', 'gemini', 'claude']);
  });

  it('does not mutate DEFAULT_CHAIN across calls', () => {
    order('gemini');
    order('claude');
    expect(DEFAULT_CHAIN).toEqual(['codex', 'gemini', 'claude']);
  });
});

describe('maxRetries() — per-reason caps (spec §6.3)', () => {
  it('transient -> 2', () => expect(maxRetries('transient')).toBe(2));
  it('rate-limit -> 2', () => expect(maxRetries('rate-limit')).toBe(2));
  it('timeout -> 1', () => expect(maxRetries('timeout')).toBe(1));
  it('process-fail -> 1', () => expect(maxRetries('process-fail')).toBe(1));
  it('config-error -> 0', () => expect(maxRetries('config-error')).toBe(0));
  it('no-auth -> 0', () => expect(maxRetries('no-auth')).toBe(0));
  it('no-binary -> 0', () => expect(maxRetries('no-binary')).toBe(0));
  it('undefined -> 0', () => expect(maxRetries(undefined)).toBe(0));
});

describe('backoffMs() — exponential schedule capped at 16s (spec §6.3)', () => {
  it('attempt 0 -> 1000', () => expect(backoffMs(0)).toBe(1000));
  it('attempt 1 -> 4000', () => expect(backoffMs(1)).toBe(4000));
  it('attempt 2 -> 16000', () => expect(backoffMs(2)).toBe(16000));
  it('attempt 3 -> 16000 (cap)', () => expect(backoffMs(3)).toBe(16000));
});

describe('budget constant (spec §6.3)', () => {
  it('DEFAULT_MAX_TOTAL_MS === 600000', () => {
    expect(DEFAULT_MAX_TOTAL_MS).toBe(600000);
  });
});
