import { describe, it, expect, vi } from 'vitest';

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

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

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

describe('AgentPTY.shouldDisable1MContext (SYS-1M-PREVENT)', () => {
  // An explicit non-Opus model on a no-credit plan is the failure mode the guard
  // exists to prevent: default the standard window so it cannot billing-gate-halt.
  it('disables 1M for an explicit Sonnet model (the gated class)', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'claude-sonnet-4-6' } as any, false)).toBe(true);
  });

  it('disables 1M for an explicit Haiku model', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'haiku' } as any, false)).toBe(true);
  });

  it('disables 1M for an explicit alias / unknown model', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'sonnet' } as any, false)).toBe(true);
  });

  // model:none agents inherit the harness default and sidestep the gate entirely.
  it('does NOT touch agents with no explicit config.model', () => {
    expect(AgentPTY.shouldDisable1MContext({} as any, false)).toBe(false);
    expect(AgentPTY.shouldDisable1MContext({ model: '' } as any, false)).toBe(false);
  });

  // Opus on Max/Team/Enterprise includes 1M natively (no billing gate) — disabling
  // it would be a needless context regression.
  it('exempts Opus models (native 1M, no gate)', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'opus' } as any, false)).toBe(false);
    expect(AgentPTY.shouldDisable1MContext({ model: 'claude-opus-4-8' } as any, false)).toBe(false);
    expect(AgentPTY.shouldDisable1MContext({ model: 'CLAUDE-OPUS-4-7' } as any, false)).toBe(false);
  });

  // A "[1m]" suffix is a deliberate per-model opt-in; honour it (a no-credit halt
  // then surfaces via SYS-1M-DETECT — the operator's choice, not a silent default).
  it('honours an explicit [1m] opt-in suffix', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'claude-sonnet-4-6[1m]' } as any, false)).toBe(false);
    expect(AgentPTY.shouldDisable1MContext({ model: 'sonnet[1M]' } as any, false)).toBe(false);
  });

  // The agent's .env already chose (true OR false): never override the operator.
  it('respects an explicit .env setting (opt-out/opt-in) and never overrides it', () => {
    expect(AgentPTY.shouldDisable1MContext({ model: 'claude-sonnet-4-6' } as any, true)).toBe(false);
    expect(AgentPTY.shouldDisable1MContext({ model: 'opus' } as any, true)).toBe(false);
  });
});
