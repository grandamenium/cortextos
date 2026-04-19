/**
 * model-tiers.ts — 3-tier model cost routing for cortextOS agents.
 *
 * Agents can be assigned a cost tier ('haiku', 'sonnet', or 'opus') instead
 * of a hard-coded model string. The tier is resolved to a concrete model ID
 * at spawn time using DEFAULT_MODEL_TIERS (or an agent-level override).
 *
 * Precedence (highest to lowest):
 *   1. config.model          — explicit model string, bypasses tier routing
 *   2. config.tier           — maps to config.model_tiers or DEFAULT_MODEL_TIERS
 *   3. (no model set)        — Claude Code uses its own default
 *
 * This lets operators:
 *   - Assign lightweight agents (cron checkers, notifiers) to 'haiku' for cost savings
 *   - Keep knowledge-work agents on 'sonnet' (default)
 *   - Reserve 'opus' for orchestrators or complex reasoning tasks
 *   - Upgrade all agents to a new model generation by bumping DEFAULT_MODEL_TIERS
 *     in one place rather than editing every config.json
 */

import type { AgentConfig } from '../types/index.js';

/** The three cost tiers available for model routing. */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Maps each tier to a concrete Anthropic model ID. */
export type ModelTiers = Record<ModelTier, string>;

/**
 * Current Anthropic model IDs for each tier.
 * Update this when new model generations ship.
 */
export const DEFAULT_MODEL_TIERS: ModelTiers = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

/**
 * Resolve the model to pass to `--model` for a given agent config.
 *
 * Returns undefined if neither `model` nor `tier` is set, letting Claude Code
 * use its own default.
 *
 * @param config        The agent's loaded configuration.
 * @param defaultTiers  Optional override for the default tier→model mapping.
 *                      Useful in tests or when the operator wants to pin tiers
 *                      at the framework level without editing each agent config.
 */
export function resolveModel(
  config: AgentConfig,
  defaultTiers: ModelTiers = DEFAULT_MODEL_TIERS,
): string | undefined {
  // Explicit model string takes priority — backwards-compatible with existing configs.
  if (config.model) return config.model;

  // Tier-based routing: merge per-agent overrides on top of defaults.
  if (config.tier) {
    let tiers: ModelTiers = defaultTiers;
    if (config.model_tiers) {
      // Filter out undefined values before merging so that an explicitly-undefined
      // override (e.g. model_tiers: { haiku: undefined }) does not shadow the default.
      const overrides = Object.fromEntries(
        Object.entries(config.model_tiers).filter(([, v]) => v !== undefined),
      ) as Partial<ModelTiers>;
      tiers = { ...defaultTiers, ...overrides };
    }
    return tiers[config.tier];
  }

  return undefined;
}
