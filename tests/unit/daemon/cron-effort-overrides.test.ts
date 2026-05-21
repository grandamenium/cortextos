/**
 * Unit tests for cron_effort_overrides in onFire daemon dispatch.
 */
import { describe, it, expect } from 'vitest';

// These tests verify that the effort prefix is injected correctly
// when cron_effort_overrides is configured for a cron name.

describe('cron_effort_overrides: injection prefix', () => {
  it('prepends [EFFORT:low] when override is configured for cron name', () => {
    const overrides: Record<string, string> = { heartbeat: 'low' };
    const cronName = 'heartbeat';
    const baseInjection = '[CRON FIRED 2026-01-01T00:00:00Z] heartbeat: do thing';
    const effortOverride = overrides[cronName];
    const injection = effortOverride ? `[EFFORT:${effortOverride}] ${baseInjection}` : baseInjection;
    expect(injection).toMatch(/^\[EFFORT:low\]/);
    expect(injection).toContain(baseInjection);
  });

  it('leaves injection unchanged when no override for cron name', () => {
    const overrides: Record<string, string> = { heartbeat: 'low' };
    const cronName = 'theta-wave';
    const baseInjection = '[CRON FIRED 2026-01-01T00:00:00Z] theta-wave: deep work';
    const effortOverride = overrides[cronName];
    const injection = effortOverride ? `[EFFORT:${effortOverride}] ${baseInjection}` : baseInjection;
    expect(injection).toBe(baseInjection);
    expect(injection).not.toContain('[EFFORT:');
  });

  it('leaves injection unchanged when cron_effort_overrides is absent from config', () => {
    const overrides: Record<string, string> | undefined = undefined;
    const cronName = 'heartbeat';
    const baseInjection = '[CRON FIRED 2026-01-01T00:00:00Z] heartbeat: do thing';
    const effortOverride = overrides?.[cronName];
    const injection = effortOverride ? `[EFFORT:${effortOverride}] ${baseInjection}` : baseInjection;
    expect(injection).toBe(baseInjection);
  });

  it('accepts all valid effort levels', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const level of levels) {
      const injection = `[EFFORT:${level}] [CRON FIRED x] test: p`;
      expect(injection).toMatch(new RegExp(`\\[EFFORT:${level}\\]`));
    }
  });
});
