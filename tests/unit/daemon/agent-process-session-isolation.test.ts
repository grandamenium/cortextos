import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';
import { getDeterministicAgentSessionId } from '../../../src/utils/agent-session-isolation.js';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  openSync: vi.fn().mockReturnValue(1),
  readSync: vi.fn(),
  closeSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get readdirSync() { return fsMocks.readdirSync; },
    get openSync() { return fsMocks.openSync; },
    get readSync() { return fsMocks.readSync; },
    get closeSync() { return fsMocks.closeSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const env = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.onExit.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
  fsMocks.openSync.mockReset().mockReturnValue(1);
  fsMocks.readSync.mockReset();
  fsMocks.closeSync.mockReset();
});

describe('AgentProcess session isolation', () => {
  it('starts fresh when only a foreign cwd-scoped JSONL exists', async () => {
    const projectsRoot = `${homedir()}/.claude/projects`;
    fsMocks.readdirSync.mockImplementation((path: unknown) => {
      const asString = String(path);
      if (asString === projectsRoot) {
        return [{ name: '-Users-joshweiss-code-auditos', isDirectory: () => true }];
      }
      return [];
    });
    fsMocks.existsSync.mockImplementation((path: unknown) => String(path) === projectsRoot);

    const ap = new AgentProcess('alice', env, {});
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('continues only when its own deterministic session file exists', async () => {
    const sessionId = getDeterministicAgentSessionId('alice', 'acme');
    const projectsRoot = `${homedir()}/.claude/projects`;
    const expectedSessionPath = `${projectsRoot}/-Users-joshweiss-code-auditos/${sessionId}.jsonl`;

    fsMocks.readdirSync.mockImplementation((path: unknown) => {
      const asString = String(path);
      if (asString === projectsRoot) {
        return [{ name: '-Users-joshweiss-code-auditos', isDirectory: () => true }];
      }
      return [];
    });
    fsMocks.existsSync.mockImplementation((path: unknown) => {
      const asString = String(path);
      return asString === projectsRoot || asString === expectedSessionPath;
    });

    const ap = new AgentProcess('alice', env, {});
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.stringContaining('SESSION CONTINUATION'));
  });

  it('rate-limit exits back off without incrementing crash_count', async () => {
    const rateLimitOutput = 'Anthropic API rate_limit_error: Too Many Requests';

    fsMocks.existsSync.mockImplementation((path: unknown) => {
      const asString = String(path);
      return asString.endsWith('/logs/alice/stdout.log');
    });
    fsMocks.statSync.mockReturnValue({ size: rateLimitOutput.length });
    fsMocks.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
      buffer.write(rateLimitOutput, 0, 'utf-8');
      return rateLimitOutput.length;
    });

    const ap = new AgentProcess('alice', env, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(0);
    expect(fsMocks.appendFileSync).toHaveBeenCalled();
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });
});
