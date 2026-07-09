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

describe('AgentPTY interactive dialog auto-accept', () => {
  function makeMockPty() {
    const handlers: { onData?: (d: string) => void; onExit?: (e: any) => void } = {};
    const writes: string[] = [];
    const pty = {
      pid: 1234,
      write: vi.fn((d: string) => writes.push(d)),
      onData: vi.fn((cb: (d: string) => void) => {
        handlers.onData = cb;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn((cb: (e: any) => void) => {
        handlers.onExit = cb;
        return { dispose: vi.fn() };
      }),
      kill: vi.fn(),
      resize: vi.fn(),
    };
    return { pty, handlers, writes };
  }

  it('does NOT respond to the bypass-permissions warning banner alone (regression: firing here sends keystrokes into a still-forming screen)', async () => {
    const { pty, handlers, writes } = makeMockPty();
    const agent = new AgentPTY(mockEnv, {});
    (agent as any).spawnFn = vi.fn().mockReturnValue(pty);
    await agent.spawn('fresh', 'PROMPT');

    handlers.onData!('WARNING: Claude Code running in Bypass Permissions mode\nIn Bypass Permissions mode...');
    await new Promise((r) => setTimeout(r, 400));

    expect(writes).toHaveLength(0);
  });

  it('responds "2" + Enter once the full bypass-permissions menu (both options) is visible', async () => {
    const { pty, handlers, writes } = makeMockPty();
    const agent = new AgentPTY(mockEnv, {});
    (agent as any).spawnFn = vi.fn().mockReturnValue(pty);
    await agent.spawn('fresh', 'PROMPT');

    handlers.onData!('WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm');
    await new Promise((r) => setTimeout(r, 400));

    expect(writes).toEqual(['2', '\r']);
  });

  it('does NOT respond to the trust-folder banner text alone, only the actual option line', async () => {
    const { pty, handlers, writes } = makeMockPty();
    const agent = new AgentPTY(mockEnv, {});
    (agent as any).spawnFn = vi.fn().mockReturnValue(pty);
    await agent.spawn('fresh', 'PROMPT');

    handlers.onData!('Is this a project you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit');
    await new Promise((r) => setTimeout(r, 400));

    expect(writes).toEqual(['\r']);
  });

  it('retries the bypass response (up to a cap) if the menu keeps repainting, without unbounded spam', async () => {
    const { pty, handlers, writes } = makeMockPty();
    const agent = new AgentPTY(mockEnv, {});
    (agent as any).spawnFn = vi.fn().mockReturnValue(pty);
    await agent.spawn('fresh', 'PROMPT');

    const menu = '❯ 1. No, exit\n  2. Yes, I accept';
    for (let i = 0; i < 6; i++) {
      handlers.onData!(menu);
    }
    await new Promise((r) => setTimeout(r, 1200));

    // 3 retries * 2 writes each ('2' then '\r') = 6, never more.
    expect(writes.length).toBeLessThanOrEqual(6);
    expect(writes.length).toBeGreaterThan(0);
  });
});

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
