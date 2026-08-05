import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockOpencodePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(13579),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
};

const mockAgentPty = {
  ...mockOpencodePty,
  getPid: vi.fn().mockReturnValue(12345),
  // CodexAppServerPTY exposes setTelegramHandle; start() calls it when a codex
  // agent has a Telegram handle wired (src/daemon/agent-process.ts).
  setTelegramHandle: vi.fn(),
};

const mockOpencodeSessionExists = vi.fn().mockReturnValue(false);

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockOpencodePty; },
  opencodeSessionExists: (...args: unknown[]) => mockOpencodeSessionExists(...args),
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
    unlinkSync: vi.fn(),
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
  agentName: 'opencode-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/opencode-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockOpencodePty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockOpencodeSessionExists.mockReset().mockReturnValue(false);
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess opencode runtime', () => {
  it('selects OpencodePTY for runtime opencode', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();

    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(13579);
  });

  it('uses opencode session marker for continue mode', async () => {
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();

    expect(mockOpencodeSessionExists).toHaveBeenCalledWith('/tmp/test-ctx', 'opencode-agent');
    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('does not prompt non-Telegram opencode agents to send back-online Telegram', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, {
      runtime: 'opencode',
      telegram_polling: false,
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('send a Telegram message');
    expect(prompt).not.toContain('Send a Telegram message');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('prompts Telegram-enabled opencode agents to send back-online Telegram on fresh start', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined) } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('Send a Telegram message to the user saying you are back online.');
  });

  it('sends daemon-direct back-online Telegram for opencode fresh start', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent opencode-agent is back online');
  });

  it('prompts Telegram-enabled opencode agents to send back-online Telegram on continue start', async () => {
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined) } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(prompt).toContain('After checking inbox, send a Telegram message to the user saying you are back online.');
  });

  it('sends daemon-direct back-online Telegram for opencode continue start', async () => {
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent opencode-agent is back online');
  });

  it('sends daemon msg1 and relies on the handoff prompt for opencode msg2', async () => {
    const handoffDocPath = '/tmp/opencode-handoff.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path')
        || path.endsWith('.restart-planned')
        || path === handoffDocPath),
    );
    fsMocks.readFileSync.mockImplementation((path: string) =>
      typeof path === 'string' && path.endsWith('.restart-planned')
        ? 'context handoff at 92%\n'
        : handoffDocPath,
    );

    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(prompt).toContain('VERY FIRST tool call MUST be a Bash call running');
    expect(prompt).toContain("cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'back");
    // msg1: hook parity — codex/opencode don't run Claude Code hooks, so the
    // daemon emits the planned-restart lifecycle notif itself.
    expect(sendMessage).toHaveBeenCalledWith('12345', '🔄 opencode-agent restarted (planned): context handoff at 92%');
    // msg2: opencode receives the same prompt-level first-action requirement as
    // codex, so the daemon must not synthesize a weaker generic handoff ping.
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent opencode-agent is back online (context handoff)');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent opencode-agent is back online');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends msg1 (planned-restart) but NOT msg2 on codex handoff restart (codex self-sends its own back-online)', async () => {
    const handoffDocPath = '/tmp/codex-handoff.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path')
        || path.endsWith('.restart-planned')
        || path === handoffDocPath),
    );
    fsMocks.readFileSync.mockImplementation((path: string) =>
      typeof path === 'string' && path.endsWith('.restart-planned')
        ? 'context handoff at 88%\n'
        : handoffDocPath,
    );

    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex-app-server', allow_codex_app_server: true });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    // msg1: daemon-emitted hook parity, same as opencode.
    expect(sendMessage).toHaveBeenCalledWith('12345', '🔄 codex-agent restarted (planned): context handoff at 88%');
    // msg2: codex reliably self-sends its own "back — ..." reply, so the daemon
    // must NOT also send a back-online ping (that would double up).
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-agent is back online (context handoff)');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-agent is back online');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not use Claude /exit choreography on stop', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockOpencodePty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
  }, 10000);
});
