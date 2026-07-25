import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get readdirSync() { return fsMocks.readdirSync; },
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 77,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  }),
}));

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/test-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

function callBuildArgs(pty: unknown, mode: 'fresh' | 'continue', prompt: string): string[] {
  return (pty as { buildClaudeArgs(m: string, p: string): string[] })
    .buildClaudeArgs(mode, prompt);
}

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
});

describe('AgentPTY.buildClaudeArgs', () => {
  it('fresh mode without mcp config: no --continue, no strict-mcp flags', () => {
    const pty = new AgentPTY(mockEnv, {});
    const args = callBuildArgs(pty, 'fresh', 'hi');
    expect(args).toEqual(['--dangerously-skip-permissions', 'hi']);
  });

  it('continue mode without mcp config: --continue first, prompt last', () => {
    const pty = new AgentPTY(mockEnv, {});
    const args = callBuildArgs(pty, 'continue', 'resume prompt');
    expect(args).toEqual(['--continue', '--dangerously-skip-permissions', 'resume prompt']);
  });

  it('mcp.strict without config_file: no strict-mcp flags emitted', () => {
    const pty = new AgentPTY(mockEnv, { mcp: { strict: true } });
    const args = callBuildArgs(pty, 'continue', 'p');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args.find(a => a.startsWith('--mcp-config'))).toBeUndefined();
  });

  it('mcp.config_file without strict: no strict-mcp flags emitted', () => {
    const pty = new AgentPTY(mockEnv, { mcp: { config_file: '/tmp/mcp.json' } });
    const args = callBuildArgs(pty, 'continue', 'p');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args.find(a => a.startsWith('--mcp-config'))).toBeUndefined();
  });

  it('mcp strict + config_file: emits --mcp-config=<path> single-token, NOT space-separated', () => {
    const pty = new AgentPTY(mockEnv, {
      mcp: { strict: true, config_file: '/tmp/mcp.json' },
    });
    const args = callBuildArgs(pty, 'continue', 'huge resume prompt payload');

    // Single-token form — this is the whole point of the fix.
    expect(args).toContain('--mcp-config=/tmp/mcp.json');
    // No space-separated form (regression guard: claude CLI treats --mcp-config
    // as variadic and would absorb the trailing prompt as another config path).
    expect(args).not.toContain('--mcp-config');
    // Prompt is the final positional arg.
    expect(args[args.length - 1]).toBe('huge resume prompt payload');
  });

  it('mcp strict + config_file + model: exact argv order', () => {
    const pty = new AgentPTY(mockEnv, {
      model: 'claude-opus-4-7',
      mcp: { strict: true, config_file: '/etc/mcp.json' },
    });
    const args = callBuildArgs(pty, 'continue', 'p');
    expect(args).toEqual([
      '--continue',
      '--dangerously-skip-permissions',
      '--model', 'claude-opus-4-7',
      '--strict-mcp-config',
      '--mcp-config=/etc/mcp.json',
      'p',
    ]);
  });

  it('argv token AFTER --mcp-config value is the prompt (positional), not adjacent to it', () => {
    // Regression guard for the ENAMETOOLONG bug: when --mcp-config took a
    // separate value token, claude CLI absorbed the trailing prompt as an
    // additional config file path.
    const pty = new AgentPTY(mockEnv, {
      mcp: { strict: true, config_file: '/tmp/mcp.json' },
    });
    const args = callBuildArgs(pty, 'continue', 'PROMPT');
    const mcpTokenIdx = args.findIndex(a => a.startsWith('--mcp-config'));
    expect(mcpTokenIdx).toBeGreaterThanOrEqual(0);
    // The token right after --mcp-config=... must not be a bare path (that
    // was the old bug shape). It should be the prompt (the final positional).
    expect(args[mcpTokenIdx]).toBe('--mcp-config=/tmp/mcp.json');
    expect(args[mcpTokenIdx + 1]).toBe('PROMPT');
  });
});
