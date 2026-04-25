import { describe, it, expect, vi } from 'vitest';
import { withRetry, isTransientError } from '../../../src/utils/retry';

// Use baseDelayMs: 0 throughout to keep tests fast without fake timers.
// The utility's sleep(0) resolves on the next event-loop tick, which is
// sufficient to verify retry ordering without adding real wall-clock latency.

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on a later attempt', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      if (call < 3) throw new Error('ECONNRESET');
      return 'recovered';
    });

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      isRetryable: () => true,
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockImplementation(async () => { throw new Error('persistent'); });
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, isRetryable: () => true }),
    ).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying immediately when isRetryable returns false', async () => {
    const fn = vi.fn().mockImplementation(async () => { throw new Error('400 Bad Request'); });
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 0,
        isRetryable: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          return !msg.includes('400');
        },
      }),
    ).rejects.toThrow('400 Bad Request');
    // Only 1 attempt — isRetryable returned false immediately
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires onRetry callback with attempt number and delay before each retry', async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let call = 0;
    const fn = vi.fn(async () => {
      if (++call < 3) throw new Error('transient');
      return 'done';
    });

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      isRetryable: () => true,
      onRetry: (attempt, _err, delayMs) => retries.push({ attempt, delayMs }),
    });

    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[1].attempt).toBe(2);
    // Delays are jittered into [base*0.5, base] range — verify positive and bounded
    expect(retries[0].delayMs).toBeGreaterThan(0);
    expect(retries[0].delayMs).toBeLessThanOrEqual(1000);
  });

  it('passes the current attempt number (1-indexed) to fn', async () => {
    const attempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error('retry me');
      return 'ok';
    });

    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, isRetryable: () => true });
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('respects maxDelayMs cap — delay never exceeds maxDelayMs', async () => {
    const delays: number[] = [];
    let call = 0;
    const fn = vi.fn(async () => {
      if (++call < 5) throw new Error('transient');
      return 'ok';
    });

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 500,
      isRetryable: () => true,
      onRetry: (_attempt, _err, delayMs) => delays.push(delayMs),
    });

    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(500);
    }
  });
});

describe('isTransientError', () => {
  it('returns true for ECONNRESET', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for AbortError (fetch timeout)', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for 429 rate limit messages', () => {
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 503 service unavailable', () => {
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns false for 400 bad request', () => {
    expect(isTransientError(new Error('Telegram API error: 400 Bad Request'))).toBe(false);
  });

  it('returns false for 403 forbidden', () => {
    expect(isTransientError(new Error('403 Forbidden'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientError('some string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});
