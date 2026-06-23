import { beforeEach, describe, it, expect, vi } from 'vitest';
import { getDeterministicAgentSessionId } from '../../../src/utils/agent-session-isolation.js';

// --- node-pty is native; stub it so constructing/spawning AgentPTY never touches it.
let onDataHandler: ((data: string) => void) | null = null;

const mockInnerPty = {
  pid: 42,
  write: vi.fn(),
  onData: vi.fn().mockImplementation((cb: (data: string) => void) => {
    onDataHandler = cb;
    return { dispose: vi.fn() };
  }),
  onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  kill: vi.fn(),
  resize: vi.fn(),
};

const spawnMock = vi.fn().mockReturnValue(mockInnerPty);

vi.mock('node-pty', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

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

const env = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'auditmaster',
  agentDir: '/tmp/fw/orgs/clearworksai/agents/auditmaster',
  org: 'clearworksai',
};

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

beforeEach(() => {
  onDataHandler = null;
  spawnMock.mockClear();
  mockInnerPty.write.mockClear();
  mockInnerPty.onData.mockClear();
  mockInnerPty.onExit.mockClear();
  mockInnerPty.kill.mockClear();
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

describe('AgentPTY session isolation', () => {
  it('fresh mode pins a deterministic --session-id', () => {
    const pty = new AgentPTY(env, {});
    const args = (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');

    const sessionId = getDeterministicAgentSessionId(env.agentName, env.org);
    expect(args).toContain('--session-id');
    expect(args).toContain(sessionId);
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('continue mode resumes the deterministic per-agent session ID', () => {
    const pty = new AgentPTY(env, {});
    const args = (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
      .buildClaudeArgs('continue', 'hello');

    const sessionId = getDeterministicAgentSessionId(env.agentName, env.org);
    expect(args).toContain('--resume');
    expect(args).toContain(sessionId);
    expect(args).not.toContain('--continue');
  });

  it('fast-fails when a Settings Warning modal appears', async () => {
    vi.useFakeTimers();
    try {
      const pty = new AgentPTY(env, {});
      (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;
      await pty.spawn('fresh', 'boot');
      expect(onDataHandler).not.toBeNull();

      onDataHandler!('Settings Warning\n/Users/joshweiss/code/auditos/.claude/settings.json');
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockInnerPty.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
