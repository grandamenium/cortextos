import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const atomicWriteSyncMock = vi.fn();

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: atomicWriteSyncMock,
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 88,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  }),
}));

const requestMock = vi.fn();
const notifyMock = vi.fn();
const closeMock = vi.fn();
const respondErrorMock = vi.fn();
const logEventMock = vi.fn();
let messageHandler: ((message: unknown) => void) | null = null;

vi.mock('../../../src/utils/ws-unix-client.js', () => ({
  WsUnixJsonRpcClient: vi.fn().mockImplementation(function WsUnixJsonRpcClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: closeMock,
      notify: notifyMock,
      respondError: respondErrorMock,
      onMessage: vi.fn().mockImplementation((handler: (message: unknown) => void) => {
        messageHandler = handler;
        return vi.fn();
      }),
      request: requestMock,
    };
  }),
}));

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: logEventMock,
}));

const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  requestMock.mockReset();
  notifyMock.mockReset();
  closeMock.mockReset();
  respondErrorMock.mockReset();
  logEventMock.mockReset();
  atomicWriteSyncMock.mockReset();
  messageHandler = null;
});

describe('CodexAppServerPTY socket path policy', () => {
  it('uses codex.sock in the agent state dir by default', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    expect((pty as unknown as { _socketPath: string })._socketPath).toBe('/tmp/ctx/state/codex-app-agent/codex.sock');
    expect((pty as unknown as { _socketListenArg: string })._socketListenArg).toBe('unix://./codex.sock');
  });

  it('falls back to /tmp/cas-*.sock when the state socket path is too long', () => {
    const longEnv = {
      ...mockEnv,
      ctxRoot: `/tmp/${'x'.repeat(120)}`,
    };
    const pty = new CodexAppServerPTY(longEnv, {});
    const socketPath = (pty as unknown as { _socketPath: string })._socketPath;
    expect(socketPath).toMatch(/\/cas-[a-f0-9]{8}\.sock$/);
    expect((pty as unknown as { _socketListenArg: string })._socketListenArg).toMatch(/^unix:\/\/\.\/cas-[a-f0-9]{8}\.sock$/);
    expect((pty as unknown as { _socketCwd: string })._socketCwd).toBe('/tmp');
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-socket.json'),
      expect.stringContaining('"fallback": true'),
      'utf-8',
    );
  });
});

describe('CodexAppServerPTY command mapping', () => {
  function makeReadyPty() {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _alive: boolean })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';
    (pty as unknown as { _rpc: { request: typeof requestMock; respondError: typeof respondErrorMock } })._rpc = {
      request: requestMock,
      respondError: respondErrorMock,
    };
    return pty;
  }

  it('maps /goal to thread/goal/get', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(pty.getOutputBuffer().getRecent()).toContain('[goal] none set');
  });

  it('maps Telegram-delivered /goal with bot suffix to native goal get', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
[Recent conversation:]
[user]: prior
\`\`\`
old fenced text
\`\`\`
/goal@codex_app_server_test_bot
[Your last message: "previous"]
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(pty.getOutputBuffer().getRecent()).toContain('[goal] none set');
  });

  it('maps Telegram-delivered /goal set and clear variants without starting a turn', async () => {
    requestMock
      .mockResolvedValueOnce({ result: { goal: { status: 'active' } } })
      .mockResolvedValueOnce({ result: { cleared: true } });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/goal@codex_app_server_test_bot Ship native slash routing
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/goal clear
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'thread/goal/set', {
      threadId: 'thread-1',
      objective: 'Ship native slash routing',
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'thread/goal/clear', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('maps /goal clear to thread/goal/clear', async () => {
    requestMock.mockResolvedValue({ result: { cleared: true } });
    const pty = makeReadyPty();
    pty.write('/goal clear');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/clear', { threadId: 'thread-1' });
  });

  it('mirrors /goal get reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] none set', undefined, { parseMode: null });
  });

  it('mirrors /goal set reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { goal: { status: 'active' } } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal Ship native slash routing');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] active: Ship native slash routing', undefined, { parseMode: null });
  });

  it('mirrors /goal clear reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { cleared: true } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal clear');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] cleared', undefined, { parseMode: null });
  });

  it('mirrors unknown $skill error to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }] } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('$nonexistent_skill');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(
      '7940429114',
      '[skill] unknown "nonexistent_skill". No enabled matches found.',
      undefined,
      { parseMode: null },
    );
  });

  it('does not fall back to text for unknown skills', async () => {
    requestMock.mockResolvedValue({ result: { data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }] } });
    const pty = makeReadyPty();
    pty.write('$imag');
    pty.write('\r');
    await Promise.resolve();
    expect(pty.getOutputBuffer().getRecent()).toContain('Did you mean: imagegen');
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('maps Telegram-fenced $skill input to native UserInput.skill', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
\`\`\`
$imagegen make a logo
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'imagegen', path: '/skill.md' },
        { type: 'text', text: 'make a logo', text_elements: [] },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('maps exact $skill input to native UserInput.skill', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('$imagegen make a logo');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'imagegen', path: '/skill.md' },
        { type: 'text', text: 'make a logo', text_elements: [] },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'turn/completed',
      params: {},
    });
  });

  it('rewrites /skill_name to native UserInput.skill via skills/list', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('/heartbeat');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'skill', name: 'heartbeat', path: '/h.md' }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('preserves /goal in the local goal handler (does not rewrite to skill)', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('skills/list', expect.anything());
  });

  it('replies with [skill] unknown for an unknown slash command', async () => {
    requestMock.mockResolvedValue({
      result: { data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }] },
    });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/notaskill');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(
      '7940429114',
      '[skill] unknown "notaskill". No enabled matches found.',
      undefined,
      { parseMode: null },
    );
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('preserves trailing text payload through the slash rewrite', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('/heartbeat extra context here');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'heartbeat', path: '/h.md' },
        { type: 'text', text: 'extra context here', text_elements: [] },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('routes Telegram-delivered /heartbeat through the slash rewrite', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/heartbeat
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'skill', name: 'heartbeat', path: '/h.md' }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('queues turns until native turn/completed arrives', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();
    const internals = pty as unknown as { handleRpcMessage(message: unknown): void };

    pty.write('first');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'first', text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });

    pty.write('second');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);

    internals.handleRpcMessage({ method: 'turn/completed', params: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'second', text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });

    internals.handleRpcMessage({ method: 'turn/completed', params: {} });
  });
});

describe('CodexAppServerPTY extractTelegramPayload media types', () => {
  function extract(content: string, options?: { existsSync?: boolean; readFileSync?: string }): string | null {
    if (options?.existsSync !== undefined) fsMocks.existsSync.mockReturnValue(options.existsSync);
    if (options?.readFileSync !== undefined) fsMocks.readFileSync.mockReturnValue(options.readFileSync);
    const pty = new CodexAppServerPTY(mockEnv, {});
    return (pty as unknown as { extractTelegramPayload(c: string): string | null }).extractTelegramPayload(content);
  }

  it('photo: surfaces both caption and local_file path', () => {
    const inject = `=== TELEGRAM PHOTO from James (chat_id:7940429114) ===
caption:
\`\`\`
what's in this image
\`\`\`
local_file: telegram-images/2026-05-08_xyz.jpg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[PHOTO]');
    expect(out).toContain("caption: what's in this image");
    expect(out).toContain('local_file: telegram-images/2026-05-08_xyz.jpg');
  });

  it('document: surfaces caption + file_name + local_file', () => {
    const inject = `=== TELEGRAM DOCUMENT from James (chat_id:7940429114) ===
caption:
\`\`\`
have a look at this PDF
\`\`\`
local_file: telegram-images/myfile.pdf
file_name: myfile.pdf
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[DOCUMENT]');
    expect(out).toContain('caption: have a look at this PDF');
    expect(out).toContain('file_name: myfile.pdf');
    expect(out).toContain('local_file: telegram-images/myfile.pdf');
  });

  it('voice without transcript: surfaces local_file + duration but no transcript line', () => {
    const inject = `=== TELEGRAM VOICE from James (chat_id:7940429114) ===
duration: 5s
local_file: telegram-images/voice_1234.ogg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VOICE]');
    expect(out).toContain('local_file: telegram-images/voice_1234.ogg');
    expect(out).toContain('duration: 5s');
    expect(out).not.toContain('transcript:');
  });

  it('voice with transcript: surfaces transcript text', () => {
    const inject = `=== TELEGRAM VOICE from James (chat_id:7940429114) ===
duration: 5s
local_file: telegram-images/voice_1234.ogg
transcript:
\`\`\`
say hi back
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VOICE]');
    expect(out).toContain('transcript: say hi back');
    expect(out).toContain('local_file: telegram-images/voice_1234.ogg');
  });

  it('video: surfaces caption + file_name + local_file + duration', () => {
    const inject = `=== TELEGRAM VIDEO from James (chat_id:7940429114) ===
caption:
\`\`\`
demo clip
\`\`\`
duration: 12s
local_file: telegram-images/video_1234.mp4
file_name: video_1234.mp4
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VIDEO]');
    expect(out).toContain('caption: demo clip');
    expect(out).toContain('file_name: video_1234.mp4');
    expect(out).toContain('local_file: telegram-images/video_1234.mp4');
    expect(out).toContain('duration: 12s');
  });

  it('plain-text TELEGRAM (no media token) preserves existing fenced-block behavior', () => {
    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
\`\`\`
just a chat message
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toBe('just a chat message');
  });

  it('reply_to with no outbound log: appends bare in-reply-to marker', () => {
    fsMocks.existsSync.mockImplementation((p: string) => !String(p).endsWith('outbound-messages.jsonl'));
    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
[reply_to: 4242]
\`\`\`
what did you mean by that?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('what did you mean by that?');
    expect(out).toContain('[in reply to message 4242]');
  });

  it('reply_to with matching outbound log entry: appends prior message body (truncated)', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue([
      JSON.stringify({ message_id: 4241, text: 'something else' }),
      JSON.stringify({ message_id: 4242, text: 'My earlier message about the deploy' }),
      JSON.stringify({ message_id: 4243, text: 'a later one' }),
    ].join('\n'));

    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
[reply_to: 4242]
\`\`\`
what did you mean by that?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('what did you mean by that?');
    expect(out).toContain('[in reply to: My earlier message about the deploy]');
  });

  it('photo with reply_to: surfaces media payload AND reply_to marker', () => {
    fsMocks.existsSync.mockReturnValue(false);
    const inject = `=== TELEGRAM PHOTO from James (chat_id:7940429114) ===
[reply_to: 99]
caption:
\`\`\`
follow-up image
\`\`\`
local_file: telegram-images/p.jpg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[PHOTO]');
    expect(out).toContain('caption: follow-up image');
    expect(out).toContain('local_file: telegram-images/p.jpg');
    expect(out).toContain('[in reply to message 99]');
  });
});

describe('CodexAppServerPTY thread lifecycle', () => {
  it('starts a new thread in fresh mode', async () => {
    requestMock.mockResolvedValue({ result: { thread: { id: 'fresh-thread' } } });
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> }).startOrResumeThread('fresh');

    expect(requestMock).toHaveBeenCalledWith('thread/start', {
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { features: { goals: true } },
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-thread.json'),
      expect.stringContaining('"threadId": "fresh-thread"'),
      'utf-8',
    );
  });

  it('resumes the persisted thread in continue mode', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      updatedAt: '2026-05-07T00:00:00Z',
    }));
    requestMock.mockResolvedValue({ result: { thread: { id: 'persisted-thread' } } });
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> }).startOrResumeThread('continue');

    expect(requestMock).toHaveBeenCalledWith('thread/resume', {
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { features: { goals: true } },
      excludeTurns: true,
      persistExtendedHistory: true,
    });
  });
});

describe('CodexAppServerPTY event handling', () => {
  it('bootstraps on the app-server ready marker', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    pty.getOutputBuffer().push('[codex-app-server] ready thread=abc\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('responds with an error for unsupported server requests', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _rpc: { respondError: typeof respondErrorMock } })._rpc = { respondError: respondErrorMock };
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    expect(respondErrorMock).toHaveBeenCalledWith(7, -32601, 'Unsupported app-server request: item/commandExecution/requestApproval');
    expect(logEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'codex-app-agent',
      'acme',
      'error',
      'codex_app_server_unsupported_request',
      'error',
      {
        runtime: 'codex-app-server',
        method: 'item/commandExecution/requestApproval',
        thread_id: null,
      },
    );
    expect(pty.getOutputBuffer().getRecent()).toContain('unsupported request');
  });

  it('fires Telegram typing from streamed assistant deltas', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' },
    });
    expect(api.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
    expect(pty.getOutputBuffer().getRecent()).toContain('hello');
  });

  it('registers a message handler when connecting RPC', async () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    await (pty as unknown as { connectRpc(): Promise<void> }).connectRpc();
    expect(messageHandler).not.toBeNull();
  });
});

describe('CodexAppServerPTY thread/tokenUsage/updated → context_status.json', () => {
  function feedTokenUsage(pty: InstanceType<typeof CodexAppServerPTY>, tokenUsage: unknown) {
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId: 'turn-1', tokenUsage },
    });
  }

  function lastWrittenPayload(): Record<string, unknown> | null {
    if (atomicWriteSyncMock.mock.calls.length === 0) return null;
    const lastCall = atomicWriteSyncMock.mock.calls.at(-1) as [string, string];
    return JSON.parse(lastCall[1]) as Record<string, unknown>;
  }

  it('writes context_status.json atomically with computed used_percentage', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1000 },
      total: { cachedInputTokens: 5000, inputTokens: 60000, outputTokens: 4000, reasoningOutputTokens: 1000, totalTokens: 70000 },
      modelContextWindow: 200000,
    });

    expect(atomicWriteSyncMock).toHaveBeenCalledTimes(1);
    const [path] = atomicWriteSyncMock.mock.calls[0];
    expect(path).toBe('/tmp/ctx/state/codex-app-agent/context_status.json');
    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBeCloseTo(35, 5);
    expect(payload.context_window_size).toBe(200000);
    expect(payload.exceeds_200k_tokens).toBe(false);
    expect(payload.session_id).toBe('thread-9');
    expect(typeof payload.written_at).toBe('string');
    expect(payload.current_usage).toEqual({
      input_tokens: 60000,
      output_tokens: 4000,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
    });
  });

  it('falls back to default 256000 cap when modelContextWindow is null', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 64000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 64000 },
      modelContextWindow: null,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.context_window_size).toBe(256000);
    expect(payload.used_percentage).toBeCloseTo(25, 5);
  });

  it('honours codex_context_cap config override when modelContextWindow is null', () => {
    const pty = new CodexAppServerPTY(mockEnv, { codex_context_cap: 100000 });
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 50000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50000 },
      modelContextWindow: null,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.context_window_size).toBe(100000);
    expect(payload.used_percentage).toBeCloseTo(50, 5);
  });

  it('flags exceeds_200k_tokens once total > 200k', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 210000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 210000 },
      modelContextWindow: 1000000,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.exceeds_200k_tokens).toBe(true);
  });

  it('clamps used_percentage to 100 when totals exceed cap', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 300000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 300000 },
      modelContextWindow: 256000,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBe(100);
  });

  it('skips the write when params.tokenUsage is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId: 'turn-1' },
    });
    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('skips the write when total.totalTokens is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    });
    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('still emits the event log line even on a successful context write', () => {
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1000 },
      modelContextWindow: 200000,
    });
    expect(pty.getOutputBuffer().getRecent()).toContain('[codex-app-server:event] thread/tokenUsage/updated');
  });

  it('does not throw when atomicWriteSync rejects (write failure is non-fatal)', () => {
    atomicWriteSyncMock.mockImplementationOnce(() => { throw new Error('disk full'); });
    const pty = new CodexAppServerPTY(mockEnv, {});
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    expect(() => feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1000 },
      modelContextWindow: 200000,
    })).not.toThrow();
  });
});
