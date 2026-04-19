import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_TIERS,
  resolveModel,
} from '../../../src/utils/model-tiers';
import type { AgentConfig } from '../../../src/types/index';

describe('DEFAULT_MODEL_TIERS', () => {
  it('defines all three tiers', () => {
    expect(DEFAULT_MODEL_TIERS.haiku).toBeDefined();
    expect(DEFAULT_MODEL_TIERS.sonnet).toBeDefined();
    expect(DEFAULT_MODEL_TIERS.opus).toBeDefined();
  });

  it('uses non-empty model IDs', () => {
    for (const id of Object.values(DEFAULT_MODEL_TIERS)) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveModel', () => {
  const base: AgentConfig = {};

  it('returns undefined when neither model nor tier is set', () => {
    expect(resolveModel(base)).toBeUndefined();
  });

  it('returns the explicit model string when set', () => {
    expect(resolveModel({ ...base, model: 'claude-custom-model' })).toBe('claude-custom-model');
  });

  it('explicit model takes priority over tier', () => {
    expect(resolveModel({ ...base, model: 'explicit', tier: 'opus' })).toBe('explicit');
  });

  it('resolves haiku tier to correct model ID', () => {
    expect(resolveModel({ ...base, tier: 'haiku' })).toBe(DEFAULT_MODEL_TIERS.haiku);
  });

  it('resolves sonnet tier to correct model ID', () => {
    expect(resolveModel({ ...base, tier: 'sonnet' })).toBe(DEFAULT_MODEL_TIERS.sonnet);
  });

  it('resolves opus tier to correct model ID', () => {
    expect(resolveModel({ ...base, tier: 'opus' })).toBe(DEFAULT_MODEL_TIERS.opus);
  });

  it('per-agent model_tiers override merges with defaults', () => {
    const config: AgentConfig = {
      tier: 'haiku',
      model_tiers: { haiku: 'claude-haiku-custom' },
    };
    expect(resolveModel(config)).toBe('claude-haiku-custom');
  });

  it('per-agent model_tiers override does not affect other tiers', () => {
    const config: AgentConfig = {
      tier: 'sonnet',
      model_tiers: { haiku: 'claude-haiku-custom' },
    };
    expect(resolveModel(config)).toBe(DEFAULT_MODEL_TIERS.sonnet);
  });

  it('accepts a custom defaultTiers argument', () => {
    const custom = { haiku: 'h', sonnet: 's', opus: 'o' };
    expect(resolveModel({ ...base, tier: 'opus' }, custom)).toBe('o');
  });

  it('per-agent model_tiers merges on top of custom defaultTiers', () => {
    const custom = { haiku: 'h', sonnet: 's', opus: 'o' };
    const config: AgentConfig = {
      tier: 'opus',
      model_tiers: { opus: 'o-override' },
    };
    expect(resolveModel(config, custom)).toBe('o-override');
  });

  it('undefined model_tiers values do not shadow defaults', () => {
    // model_tiers: { haiku: undefined } should NOT overwrite DEFAULT_MODEL_TIERS.haiku
    const config: AgentConfig = {
      tier: 'haiku',
      model_tiers: { haiku: undefined },
    };
    expect(resolveModel(config)).toBe(DEFAULT_MODEL_TIERS.haiku);
  });
});
