import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeterministicAgentSessionId } from '../../../src/utils/agent-session-isolation.js';

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

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const env = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'auditmaster',
  agentDir: '/tmp/fw/orgs/clearworksai/agents/auditmaster',
  org: 'clearworksai',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  onDataHandler = null;
  spawnMock.mockClear();
  mockInnerPty.write.mockClear();
  mockInnerPty.onData.mockClear();
  mockInnerPty.onExit.mockClear();
  mockInnerPty.kill.mockClear();
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
