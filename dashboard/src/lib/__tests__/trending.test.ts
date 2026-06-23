import { describe, expect, it } from 'vitest';
import { parseTrendingReason } from '../data/trending';

describe('parseTrendingReason', () => {
  it('parses STEAL verdicts and strips the prefix', () => {
    expect(parseTrendingReason('STEAL — strong fit for our stack')).toEqual({
      verdict: 'steal',
      reason: 'strong fit for our stack',
    });
  });

  it('parses SKIP verdicts and strips the prefix', () => {
    expect(parseTrendingReason('SKIP - no overlap')).toEqual({
      verdict: 'skip',
      reason: 'no overlap',
    });
  });

  it('returns unknown for missing or unprefixed reasons', () => {
    expect(parseTrendingReason()).toEqual({
      verdict: 'unknown',
      reason: '',
    });
    expect(parseTrendingReason('Interesting, but undecided')).toEqual({
      verdict: 'unknown',
      reason: 'Interesting, but undecided',
    });
  });
});
