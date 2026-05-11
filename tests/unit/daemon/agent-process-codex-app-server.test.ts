import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockCodexAppServerPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(24680),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

const mockAgentPty = {
  ...mockCodexAppServerPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
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
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
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
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockCodexAppServerPty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockCodexAppServerPty.setTelegramHandle.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess codex-app-server runtime', () => {
  it('selects CodexAppServerPTY for runtime codex-app-server', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(24680);
  });

  it('wires Telegram handle to CodexAppServerPTY before start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockCodexAppServerPty.setTelegramHandle).toHaveBeenCalledWith(api, '12345');
  });

  it('uses direct kill path on stop, not Claude /exit choreography', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockCodexAppServerPty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).not.toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
    expect(mockCodexAppServerPty.kill).toHaveBeenCalled();
  }, 10000);
});

