import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

// Stub node-pty so CodexPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 77,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  }),
}));

const { CodexPTY } = await import('../../../src/pty/codex-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.writeFileSync.mockReset();
});

describe('CodexPTY typing-indicator wiring (issue #330)', () => {
  function makeStubApi() {
    return { sendChatAction: vi.fn().mockResolvedValue(undefined) };
  }

  it('does not fire sendChatAction when no Telegram handle is set', () => {
    const pty = new CodexPTY(mockEnv, {});
    // No setTelegramHandle call → maybeFireTyping must be a no-op
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(true).toBe(true); // no throw, no API call possible
  });

  it('fires sendChatAction once on a non-completion JSONL event', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();

    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
    expect(api.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
  });

  it('rate-limits sendChatAction to one call per 4s', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Three rapid back-to-back fires inside the 4s window
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();

    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
  });

  it('fires again after the 4s window elapses', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Force first fire's timestamp into the past by reaching into the field.
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);

    // Roll the rate-limit clock back by 5s to simulate elapsed wall time.
    (pty as unknown as { _typingLastSent: number })._typingLastSent = Date.now() - 5000;
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(api.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('swallows sendChatAction rejections silently (non-fatal)', async () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = { sendChatAction: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')) };
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Must not throw
    expect(() => (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping()).not.toThrow();
    // Allow the rejected promise to settle so vitest doesn't flag an unhandled rejection
    await new Promise((r) => setTimeout(r, 0));
    expect(api.sendChatAction).toHaveBeenCalled();
  });
});

describe('CodexPTY bootstrap pattern', () => {
  it('isBootstrapped() fires on thread.started JSONL', () => {
    const pty = new CodexPTY(mockEnv, {});
    pty.getOutputBuffer().push('{"type":"thread.started","id":"abc"}\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() stays false on unrelated output', () => {
    const pty = new CodexPTY(mockEnv, {});
    pty.getOutputBuffer().push('loading codex...\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });
});
