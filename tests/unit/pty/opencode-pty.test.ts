import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
};

let spawnCall: { file: string; args: string[]; options: any } | null = null;
const mockPty = {
  pid: 42,
  write: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  resize: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get mkdirSync() { return fsMocks.mkdirSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get readdirSync() { return fsMocks.readdirSync; },
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockImplementation((file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  }),
}));

const { OpencodePTY, opencodeSessionExists } = await import('../../../src/pty/opencode-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'opencode-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/opencode-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  spawnCall = null;
  mockPty.write.mockClear();
  mockPty.onData.mockClear();
  mockPty.onExit.mockClear();
  mockPty.kill.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.mkdirSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  fsMocks.readFileSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
});

describe('OpencodePTY', () => {
  function installSpawnMock(pty: OpencodePTY): void {
    (pty as unknown as { spawnFn: typeof mockSpawn }).spawnFn = mockSpawn;
  }

  const mockSpawn = (file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  };

  it('returns opencode as the binary name', () => {
    const pty = new OpencodePTY(mockEnv, {});
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('opencode');
  });

  it('builds fresh args with --model and --agent but no launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'anthropic/claude-sonnet-4',
      opencode_agent: 'build',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');

    expect(args).toEqual([
      '--model', 'anthropic/claude-sonnet-4',
      '--agent', 'build',
    ]);
  });

  it('adds --continue in continue mode without passing a launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'resume me');

    expect(args).toEqual(['--continue']);
  });

  it('starts the persistent TUI without a launch-time prompt', async () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'openai/gpt-4.1-nano',
      opencode_agent: 'build',
    });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot prompt');

    expect(spawnCall?.args).toEqual([
      '--model', 'openai/gpt-4.1-nano',
      '--agent', 'build',
    ]);
  });

  it('sets OPENCODE_CONFIG_DIR under the agent directory when spawning', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.file).toBe('opencode');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe('/tmp/fw/orgs/acme/agents/opencode-agent/.opencode');
  });

  it('isolates OpenCode data, config, state, and cache under cortextOS agent state', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/cache');
  });

  it('overrides inherited XDG roots so OpenCode state stays agent-isolated by default', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env') {
        return [
          'XDG_DATA_HOME=/global/data',
          'XDG_CONFIG_HOME=/global/config',
          'XDG_STATE_HOME=/global/state',
          'XDG_CACHE_HOME=/global/cache',
          '',
        ].join('\n');
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/cache');
  });

  it('supports an explicit OPENCODE_XDG_ROOT override for custom isolated roots', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env') {
        return 'OPENCODE_XDG_ROOT=/custom/opencode\n';
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME).toBe('/custom/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME).toBe('/custom/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME).toBe('/custom/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME).toBe('/custom/opencode/cache');
  });

  it('keeps OPENCODE_CONFIG_DIR under the agent directory even when working_directory differs', async () => {
    const pty = new OpencodePTY(mockEnv, { working_directory: '/tmp/project-checkout' });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.cwd).toBe('/tmp/project-checkout');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe('/tmp/fw/orgs/acme/agents/opencode-agent/.opencode');
  });

  it('maps GEMINI_API_KEY to OpenCode Google provider env name when needed', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/secrets.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/secrets.env') return 'GEMINI_API_KEY=gemini-secret\n';
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('gemini-secret');
  });

  it('writes a session marker but does not bootstrap before real TUI readiness', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent', { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/opencode-agent/opencode-session.json',
      expect.stringContaining('"runtime": "opencode"'),
      'utf-8',
    );
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);

    pty.getOutputBuffer().push('Ask anything');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('injects the startup prompt only after real TUI output is quiescent', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      expect(mockPty.write).not.toHaveBeenCalled();
      pty.getOutputBuffer().push('OpenCode rendered frame\n');
      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(9));

      expect(mockPty.write.mock.calls.map((call) => call[0]).join('')).toContain('boot prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('injects inbound messages as raw control-stripped text for the OpenCode TUI', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage('hello\x1b[31m red\rthere');

      // Esc fires first (synchronously) to exit any lingering OpenCode shell mode.
      expect(mockPty.write).toHaveBeenCalledTimes(1);
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');

      // Content is typed after the shell-reset settle delay.
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('hello red\nthere');
      expect(mockPty.write.mock.calls[1][0]).not.toContain('\x1b[200~');
      expect(mockPty.write.mock.calls[1][0]).not.toContain('\x1b[201~');

      // Enter is submitted after the existing 300ms deferral.
      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('adds a strict Telegram send requirement for OpenCode Telegram inbound', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Yo',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      // Esc fires first to exit shell mode, then content after the settle delay.
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);

      const written = mockPty.write.mock.calls[1][0];
      expect(written).toContain('=== TELEGRAM from [USER: James] (chat_id:7940429114) ===');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');
      expect(written).toContain("cortextos bus send-telegram 7940429114 '<your reply>'");
      expect(written).toContain('A plain answer printed only in the OpenCode TUI is NOT delivered');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('elevates Telegram reply target context for ambiguous OpenCode follow-ups', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '[Replying to: "Code review done — 95 files, ~18.5k lines analyzed. Full HTML breakdown attached.\\n[document: hermes-memory-review.html]"]',
        '```',
        "what's this?",
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);

      const written = mockPty.write.mock.calls[1][0];
      expect(written).toContain('[OPENCODE REPLY TARGET]');
      expect(written).toContain('The Telegram user replied to this specific prior message:');
      expect(written).toContain('Code review done — 95 files');
      expect(written).toContain('[document: hermes-memory-review.html]');
      expect(written).toContain('If the user says "this", "that", "it"');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('escapes OpenCode shell mode before every Telegram inbound injection', async () => {
    // Regression for the multi-turn shell-mode bug: after the agent runs the
    // reply-protocol `send-telegram` command the TUI is left in shell mode, so
    // a second inbound must get its own Esc reset before being typed, otherwise
    // it lands at the zsh prompt and produces no reply. Each injection =
    // Esc -> (150ms) content -> (300ms) Enter, so advance 450ms per message.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      const firstTelegram = [
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'First',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n');
      const secondTelegram = [
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Second after shell command',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n');

      pty.injectMessage(firstTelegram);
      await vi.advanceTimersByTimeAsync(450);
      pty.injectMessage(secondTelegram);
      await vi.advanceTimersByTimeAsync(450);

      expect(mockPty.write.mock.calls.map((call) => call[0])).toEqual([
        '\x1b',
        expect.stringContaining('First'),
        '\r',
        '\x1b',
        expect.stringContaining('Second after shell command'),
        '\r',
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('exit-recovers when a cron/heartbeat left the TUI at a real zsh shell prompt', async () => {
    // Regression for the heartbeat/check-inbox shell bug: OpenCode's own crons
    // run terminal commands that leave the TUI at a bare `$` prompt. The NEXT
    // Telegram inbound then lands at zsh (`command not found`) and produces no
    // reply. Esc alone does not exit that stuck prompt — a typed `exit` does.
    // When the tail shows a zsh prompt with no chat markers, injection must be
    // Esc -> (150ms) exit + Enter -> (500ms settle) content -> (300ms) Enter.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      // Simulate the post-cron stuck state: a real zsh prompt at the tail, no
      // chat readiness markers anywhere near it.
      pty.getOutputBuffer().push('cortextos bus update-heartbeat\n');
      pty.getOutputBuffer().push('heartbeat updated\n');
      pty.getOutputBuffer().push('boris@host cortextos % ');

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Yo',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      // Esc fires synchronously.
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');

      // After the 150ms reset delay, the typed exit-recovery fires (NOT content).
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('exit');
      expect(mockPty.write.mock.calls[2][0]).toBe('\r');

      // Content is typed only after the 500ms shell-exit settle delay.
      await vi.advanceTimersByTimeAsync(500);
      const written = mockPty.write.mock.calls[3][0];
      expect(written).toContain('=== TELEGRAM from [USER: James] (chat_id:7940429114) ===');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');

      // Then the usual submit Enter.
      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does NOT type a spurious exit when the TUI tail shows chat readiness', async () => {
    // The conservative default: when chat markers are present at the tail, even
    // if a `$`/`%` appears earlier in scrollback, injection stays in chat mode
    // (Esc -> content -> Enter) and never submits a stray `exit` chat message.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      // A normal chat-ready tail: the input chrome is rendered.
      pty.getOutputBuffer().push('some earlier shell output $ \n');
      pty.getOutputBuffer().push('Ask anything\n');
      pty.getOutputBuffer().push('ctrl+p commands\n');

      pty.injectMessage('hello there');

      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('hello there');
      // No `exit` was ever written.
      expect(mockPty.write.mock.calls.map((call) => call[0])).not.toContain('exit');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not blindly inject the startup prompt when TUI readiness is never detected', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(65));

      expect(mockPty.write).not.toHaveBeenCalled();
      expect(pty.getOutputBuffer().getRecent()).toContain('startup prompt not injected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up a stale recorded OpenCode process before spawning a replacement', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    fsMocks.existsSync.mockImplementation((path: string) =>
      path === '/tmp/ctx/state/opencode-agent/opencode-process.json');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/ctx/state/opencode-agent/opencode-process.json') {
        return JSON.stringify({ pid: 24680 });
      }
      return '';
    });

    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');

      expect(killSpy).toHaveBeenCalledWith(24680, 'SIGTERM');
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent/opencode-process.json');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('removes the recorded OpenCode process marker on explicit kill', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', '');

    pty.kill();

    expect(mockPty.kill).toHaveBeenCalled();
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent/opencode-process.json');
  });
});

function STARTUP_TICKS(count: number): number {
  return count * 500;
}

describe('opencodeSessionExists', () => {
  it('checks the cortextOS state marker for this agent', () => {
    const expected = join('/tmp/ctx', 'state', 'opencode-agent', 'opencode-session.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === expected);

    expect(opencodeSessionExists('/tmp/ctx', 'opencode-agent')).toBe(true);
  });
});
