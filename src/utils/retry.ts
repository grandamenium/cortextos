/**
 * Unified retry utility with jittered exponential backoff.
 *
 * Consolidates inconsistent retry patterns across the codebase:
 * - telegram/poller.ts: fixed 10s backoff (Conflict only)
 * - telegram/api.ts sendMessage: no retry at all
 * - bus/send-slack.ts: no retry
 * - bus/oauth.ts: no retry
 *
 * See: orgs/revops-global/agents/dev/output/2026-04-25-retry-strategy-audit.md
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms for the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30_000. */
  maxDelayMs?: number;
  /**
   * Predicate to determine if an error is worth retrying.
   * If omitted, all errors are retried up to maxAttempts.
   */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Optional callback fired before each retry attempt.
   * Useful for logging or instrumentation.
   */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/**
 * Execute `fn`, retrying on failure with jittered exponential backoff.
 *
 * Backoff formula: min(maxDelayMs, baseDelayMs * 2^(attempt-1)) × jitter
 * where jitter is a uniform random value in [0.5, 1.0].
 *
 * Full jitter (×0.5 to ×1.0) avoids thundering-herd problems when
 * multiple callers retry simultaneously after the same failure.
 *
 * @param fn Async function to execute. Receives the current attempt number
 *           (1-indexed) so callers can log or adjust behaviour per attempt.
 * @param options Retry configuration. All fields are optional.
 * @returns The resolved value of `fn`.
 * @throws The last error if all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    isRetryable,
    onRetry,
  } = options;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;

      const isLast = attempt >= maxAttempts;
      if (isLast) break;

      if (isRetryable && !isRetryable(err)) break;

      const exponential = baseDelayMs * Math.pow(2, attempt - 1);
      const capped = Math.min(maxDelayMs, exponential);
      // Full jitter: uniform in [cap*0.5, cap]
      const jitter = capped * (0.5 + Math.random() * 0.5);
      const delayMs = Math.round(jitter);

      onRetry?.(attempt, err, delayMs);

      await sleep(delayMs);
    }
  }

  throw lastErr;
}

/**
 * Returns true if the error looks like a transient network or server issue
 * that is safe to retry. Conservative whitelist — only retries on errors
 * where a retry is unlikely to cause double-execution side-effects.
 *
 * Suitable for read-side operations and idempotent writes. For non-idempotent
 * operations (e.g. Telegram sendMessage) the caller should decide and pass
 * a custom predicate.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Network-level failures
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) return true;
  // HTTP 429 (rate limit) or 5xx server errors
  if (/429|Too Many Requests|503|502|500|Internal Server Error/i.test(msg)) return true;
  // Timeout (AbortError from AbortSignal.timeout)
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
