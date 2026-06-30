import { describe, it, expect, vi } from 'vitest';

const { execFileSyncMock, platformMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn(() => 'win32'),
}));

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, platform: platformMock };
});

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

describe('AgentPTY Windows teardown', () => {
  it('tree-kills the PTY PID before releasing the node-pty handle', () => {
    const handleKill = vi.fn();
    const pty = new AgentPTY(mockEnv, {});
    (pty as any).pty = { pid: 12345, kill: handleKill };
    (pty as any)._alive = true;

    pty.kill();

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '12345', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true }),
    );
    expect(handleKill).toHaveBeenCalledOnce();
  });
});
