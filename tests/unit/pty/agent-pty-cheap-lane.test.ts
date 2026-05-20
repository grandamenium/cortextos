/**
 * Tests for AgentPTY.applyCheapLaneEnv - cheap-LLM execution lane.
 *
 * Pure helper exercise: builds a PTY env map in memory, runs the
 * cheap-lane override, asserts the resulting env. No real PTY spawn.
 *
 * Spec: agents/analyst/reports/cheap-llm-lanes-spec-2026-05-20.md.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentPTY } from '../../../src/pty/agent-pty';
import type { AgentConfig } from '../../../src/types';

function baseConfig(): AgentConfig {
  return {};
}

function buildEnv(extras: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin',
    HOME: '/Users/test',
    ANTHROPIC_API_KEY: 'sk-original-anthropic-key',
    ...extras,
  };
}

describe('AgentPTY.applyCheapLaneEnv', () => {
  it('is a no-op when cheap_lane is absent', () => {
    const env = buildEnv();
    const before = { ...env };
    AgentPTY.applyCheapLaneEnv(env, baseConfig(), 'analyst');
    expect(env).toEqual(before);
  });

  it('is a no-op when cheap_lane.enabled is false', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-deepseek' });
    const before = { ...env };
    const config: AgentConfig = {
      cheap_lane: {
        enabled: false,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst');
    expect(env).toEqual(before);
  });

  it('is a no-op when cheap_lane.enabled is truthy-but-not-true (defensive guard)', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-deepseek' });
    const before = { ...env };
    const config: AgentConfig = {
      cheap_lane: {
        // @ts-expect-error - testing defensive guard against truthy non-true values
        enabled: 1,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst');
    expect(env).toEqual(before);
  });

  it('logs a warning + leaves env untouched when env_key is missing', () => {
    const env = buildEnv(); // no DEEPSEEK_API_KEY
    const before = { ...env };
    const warn = vi.fn();
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst', warn);
    expect(env).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/analyst.*DEEPSEEK_API_KEY.*missing/);
  });

  it('logs a warning + leaves env untouched when env_key is empty string', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: '' });
    const before = { ...env };
    const warn = vi.fn();
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst', warn);
    expect(env).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs a warning + leaves env untouched when env_key value is whitespace-only', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: '   ' });
    const before = { ...env };
    const warn = vi.fn();
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst', warn);
    expect(env).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('overrides ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + CLAUDE_API_KEY when active', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-deepseek-real' });
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-deepseek-real');
    expect(env.CLAUDE_API_KEY).toBe('sk-deepseek-real');
    expect(env.CTX_AGENT_MODEL).toBe('deepseek-chat');
  });

  it('trims trailing whitespace on the provider key before assigning', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: '  sk-with-spaces  \n' });
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-with-spaces');
    expect(env.CLAUDE_API_KEY).toBe('sk-with-spaces');
  });

  it('does not touch unrelated env vars', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-deepseek', PATH: '/special:/usr/bin', HOME: '/root' });
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        env_key: 'DEEPSEEK_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'analyst');
    expect(env.PATH).toBe('/special:/usr/bin');
    expect(env.HOME).toBe('/root');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-deepseek');
  });

  it('works with non-DeepSeek providers (OpenRouter pattern)', () => {
    const env = buildEnv({ OPENROUTER_API_KEY: 'sk-or-real' });
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-v3',
        env_key: 'OPENROUTER_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'mercury');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-or-real');
    expect(env.CTX_AGENT_MODEL).toBe('deepseek/deepseek-v3');
  });

  it('works with Ollama-localhost pattern (no API key required by provider but env var still mandatory)', () => {
    const env = buildEnv({ OLLAMA_API_KEY: 'ollama' });
    const config: AgentConfig = {
      cheap_lane: {
        enabled: true,
        base_url: 'http://localhost:11434/v1',
        model: 'qwen3:8b',
        env_key: 'OLLAMA_API_KEY',
      },
    };
    AgentPTY.applyCheapLaneEnv(env, config, 'felix');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434/v1');
    expect(env.ANTHROPIC_API_KEY).toBe('ollama');
    expect(env.CTX_AGENT_MODEL).toBe('qwen3:8b');
  });
});
