import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY, assertNoClaudeOAuthOverride } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY Claude OAuth override guard', () => {
  it('rejects Anthropic auth token overrides directly', () => {
    expect(() => assertNoClaudeOAuthOverride({
      ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-good',
    }, 'alice')).toThrow(/ANTHROPIC_AUTH_TOKEN overrides CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('rejects Anthropic API key overrides directly', () => {
    expect(() => assertNoClaudeOAuthOverride({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-good',
      ANTHROPIC_API_KEY: 'sk-ant-api03-legacy',
    }, 'alice')).toThrow(/ANTHROPIC_API_KEY overrides CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('allows empty override values', () => {
    expect(() => assertNoClaudeOAuthOverride({
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-good',
    }, 'alice')).not.toThrow();
  });

  it('does not pass parent Anthropic API credentials into spawned agent env', () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalClaude = process.env.CLAUDE_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'parent-anthropic-key';
    process.env.CLAUDE_API_KEY = 'parent-claude-key';
    try {
      const agent = new AgentPTY(mockEnv, {});
      const baseEnv = (agent as unknown as { getBaseEnv(): Record<string, string> }).getBaseEnv();

      expect(baseEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(baseEnv.CLAUDE_API_KEY).toBeUndefined();
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalClaude === undefined) delete process.env.CLAUDE_API_KEY;
      else process.env.CLAUDE_API_KEY = originalClaude;
    }
  });

  it('refuses to spawn when the agent .env contains an Anthropic override', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => String(path).endsWith('/.env'));
    vi.mocked(fs.readFileSync).mockImplementation(() => 'ANTHROPIC_AUTH_TOKEN=legacy-token\n');
    try {
      const agent = new AgentPTY(mockEnv, {});
      (agent as unknown as { spawnFn: unknown }).spawnFn = vi.fn();

      await expect(agent.spawn('fresh', 'PROMPT'))
        .rejects.toThrow(/ANTHROPIC_AUTH_TOKEN overrides CLAUDE_CODE_OAUTH_TOKEN/);
    } finally {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReset();
    }
  });
});
