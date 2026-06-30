import type { BackendId, Unavailability } from './base.js';

/**
 * Hermes fallback policy — pure data + thin ordering/limit functions (spec §4.3).
 *
 * No side effects, no imports beyond base.ts types. Every value here is a
 * direct codification of the fallback decision table (the retry-vs-failover
 * policy described in the module README / design notes).
 */

/**
 * Default backend chain (strategic order, spec §4.3):
 *   1. codex   — free via ChatGPT sub; moves heat off the Anthropic cap (raison d'être)
 *   2. gemini  — proven API path, separate Google quota, 1M context
 *   3. claude  — most reliable but burns Anthropic quota → LAST (the backstop we isolate)
 */
export const DEFAULT_CHAIN: BackendId[] = ['codex', 'gemini', 'claude'];

/** Budget guard default — 10 minutes (spec §4.3). */
export const DEFAULT_MAX_TOTAL_MS = 600_000;

/**
 * Return DEFAULT_CHAIN with `preferred` hoisted to index 0 and the remaining
 * backends in their original relative order. If `preferred` is undefined or not
 * a member of the chain, DEFAULT_CHAIN is returned unchanged.
 */
export function order(preferred?: BackendId): BackendId[] {
  if (preferred === undefined || !DEFAULT_CHAIN.includes(preferred)) {
    return [...DEFAULT_CHAIN];
  }
  return [preferred, ...DEFAULT_CHAIN.filter((id) => id !== preferred)];
}

/**
 * Max retries on the SAME backend for a given failure reason (spec §4.3 table,
 * EXACT). The retryable verdict is the adapter's; this caps how many times a
 * retryable failure is re-attempted before failover.
 *
 *   transient    → 2
 *   rate-limit   → 2
 *   timeout      → 1
 *   process-fail → 1
 *   config-error → 0  (the tonight gpt-5.3-codex path — failover immediately)
 *   no-auth      → 0
 *   no-binary    → 0  (never reaches execute — skipped at health)
 *   unknown/undefined → 0
 */
export function maxRetries(reason: Unavailability | undefined): number {
  switch (reason) {
    case 'transient':
      return 2;
    case 'rate-limit':
      return 2;
    case 'timeout':
      return 1;
    case 'process-fail':
      return 1;
    case 'config-error':
    case 'no-auth':
    case 'no-binary':
      return 0;
    default:
      return 0;
  }
}

/**
 * Exponential backoff schedule (spec §4.3): 1s / 4s / 16s, capped at 16s.
 *   attempt 0 → 1000
 *   attempt 1 → 4000
 *   attempt 2 → 16000
 *   attempt ≥ 3 → 16000
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 1000;
  if (attempt === 1) return 4000;
  return 16000;
}
