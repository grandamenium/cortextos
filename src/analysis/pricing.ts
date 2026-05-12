// Pricing table for token-audit.
//
// NOTE: deliberately duplicated from dashboard/src/lib/cost-parser.ts:21
// rather than extracted into a shared module. Rationale:
//   1. cortextOS is a fork of grandamenium/cortextos; the upstream-sync skill
//      pulls upstream changes regularly. Editing cost-parser.ts to export the
//      table widens the merge surface — every upstream cost-parser change
//      would touch our new fork-only re-export and produce a 3-way conflict.
//      Duplicating keeps the merge surface zero.
//   2. Pricing rarely changes; the duplication cost is one constant.
//   3. The drift-check test (tests/unit/analysis/token-audit.test.ts) asserts
//      this table is byte-identical to the dashboard's. If upstream changes
//      one, CI fails until we sync the other.
//
// Keep the keys + values byte-identical to dashboard/src/lib/cost-parser.ts.

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 3.75, cacheReadPerMillion: 1.50 },
  sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  haiku: { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08 },
  // gpt-5-codex: OpenAI list pricing as of 2026-01. cache write n/a (no separate
  // write cost on cached input). Update when codex pricing changes upstream.
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cacheWritePerMillion: 0, cacheReadPerMillion: 0.125 },
};

export function resolvePricingKey(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('codex') || lower.includes('gpt-5')) return 'gpt-5-codex';
  return 'sonnet';
}

export interface CostBreakdown {
  usd_input: number;
  usd_output: number;
  usd_cache_write: number;
  usd_cache_read: number;
  usd_total: number;
}

export function costBreakdown(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0,
): CostBreakdown {
  const key = resolvePricingKey(model);
  const pricing = MODEL_PRICING[key] ?? MODEL_PRICING.sonnet;
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  const usd_input = round((inputTokens / 1_000_000) * pricing.inputPerMillion);
  const usd_output = round((outputTokens / 1_000_000) * pricing.outputPerMillion);
  const usd_cache_write = round((cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion);
  const usd_cache_read = round((cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion);
  return {
    usd_input,
    usd_output,
    usd_cache_write,
    usd_cache_read,
    usd_total: round(usd_input + usd_output + usd_cache_write + usd_cache_read),
  };
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  return costBreakdown(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens).usd_total;
}
