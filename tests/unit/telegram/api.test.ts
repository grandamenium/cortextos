import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAPI, formatValidateError } from '../../../src/telegram/api';

// ---------------------------------------------------------------------------
// Fetch timeout tests (from main — pre-existing)
// ---------------------------------------------------------------------------
describe('TelegramAPI fetch timeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws a timeout error when fetch hangs indefinitely', async () => {
    globalThis.fetch = vi.fn(
      (_input: any, init?: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as any;

    const api = new TelegramAPI('123:TEST');
    await expect(api.getUpdates(0, 1)).rejects.toThrow(/timed out after 15s/);
  }, 20000);

  it('succeeds on normal fetch response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any;

    const api = new TelegramAPI('123:TEST');
    const res = await api.getUpdates(0, 1);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials tests (from pr-58)
// Minimal fetch mock — each test queues up 1 or 2 responses (one for getMe,
// optionally one for getChat) and asserts the resulting ValidateCredentialsResult.
// ---------------------------------------------------------------------------
type MockResponse = { status: number; body: any } | { throws: Error };

let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; body: any }> = [];

function queue(response: MockResponse): void {
  responseQueue.push(response);
}

describe('TelegramAPI.validateCredentials', () => {
  beforeEach(() => {
    responseQueue = [];
    callLog = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      callLog.push({ url, body });
      const next = responseQueue.shift();
      if (!next) {
        throw new Error('fetch called with no queued response');
      }
      if ('throws' in next) {
        throw next.throws;
      }
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => next.body,
      } as any;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: valid token + reachable user chat returns ok=true', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 200,
      body: { ok: true, result: { id: 222, type: 'private', first_name: 'Alice', is_bot: false } },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.botId).toBe(111);
      expect(result.botUsername).toBe('my_test_bot');
      expect(result.chatType).toBe('private');
      expect(result.chatTitle).toBe('Alice');
    }
    expect(callLog[0].url).toContain('/getMe');
    expect(callLog[1].url).toContain('/getChat');
    expect(callLog[1].body.chat_id).toBe('222');
  });

  it('bad_token: getMe returns 401 -> reason=bad_token', async () => {
    queue({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });

    const api = new TelegramAPI('999:BAD');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad_token');
    }
    // Critical: error message must not leak any part of the token.
    if (!result.ok) {
      const msg = formatValidateError(result);
      expect(msg).not.toContain('999');
      expect(msg).not.toContain('BAD');
      expect(msg).toMatch(/401 Unauthorized/);
    }
    // Must NOT have attempted getChat once getMe failed.
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/getMe');
  });

  it('self_chat: CHAT_ID equals getMe.id -> reason=self_chat (no getChat call)', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 1234567890, username: 'self_chat_test_bot' } } });

    const api = new TelegramAPI('1234567890:AAF3-rr');
    const result = await api.validateCredentials('1234567890');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('self_chat');
      expect(result.detail).toBe('1234567890');
      const msg = formatValidateError(result);
      // The error message must name the trap, point at the fix, and NOT
      // leak any part of the token.
      expect(msg).toContain('1234567890');
      expect(msg).toContain('BOT_TOKEN prefix');
      expect(msg).toContain('/start');
      expect(msg).toContain('getUpdates');
      expect(msg).not.toContain('AAF3');
    }
    // self_chat is caught after getMe alone — getChat must not have been called.
    expect(callLog).toHaveLength(1);
  });

  it('chat_not_found: getChat returns 400 -> reason=chat_not_found', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chat_not_found');
      expect(result.detail).toBe('222');
      const msg = formatValidateError(result);
      expect(msg).toContain('222');
      expect(msg).toContain('/start');
    }
    expect(callLog).toHaveLength(2);
  });

  it('bot_recipient: getChat returns a bot user -> reason=bot_recipient', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 200,
      body: { ok: true, result: { id: 333, type: 'private', username: 'other_bot', is_bot: true } },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('333');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bot_recipient');
      const msg = formatValidateError(result);
      expect(msg).toContain('333');
      expect(msg).toContain('bot');
    }
    expect(callLog).toHaveLength(2);
  });

  it('bot_recipient: getChat throws 403 "bots cant send messages to bots" -> reason=bot_recipient', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('333');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bot_recipient');
    }
  });

  it('network_error: fetch throws -> reason=network_error (caller treats as WARN)', async () => {
    queue({ throws: new Error('getaddrinfo ENOTFOUND api.telegram.org') });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('network_error');
      expect(result.detail).toContain('ENOTFOUND');
      const msg = formatValidateError(result);
      expect(msg).toMatch(/Telegram API/i);
    }
  });

  it('rate_limited: getMe 429 -> reason=rate_limited', async () => {
    queue({
      status: 429,
      body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
    }
  });

  it('timeout: fetch never resolves -> reason=network_error with "timed out" detail', async () => {
    // Queue nothing — fetch will just hang. Then advance fake timers past 10s
    // and assert the validator bails with network_error.
    vi.useFakeTimers();
    try {
      // Override the stubbed fetch to return a never-resolving promise.
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never resolves */ })));

      const api = new TelegramAPI('111:AAA');
      const pending = api.validateCredentials('222');

      // Advance fake timers past the 10s withTimeout cap. The internal
      // setTimeout in withTimeout rejects, validateCredentials catches,
      // returns network_error.
      await vi.advanceTimersByTimeAsync(10_500);

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('network_error');
        expect(result.detail).toMatch(/timed out after 10s/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('empty chat_id: reason=chat_not_found with no API calls', async () => {
    // Note: this must NOT call fetch at all, so queue nothing.
    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chat_not_found');
    }
    expect(callLog).toHaveLength(0);
  });
});

describe('formatValidateError', () => {
  it('bad_token: does not leak token or detail in user-facing text', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'bad_token',
      detail: 'Telegram API error: Unauthorized TOKEN_SECRET_123',
    });
    expect(msg).not.toContain('TOKEN_SECRET_123');
    expect(msg).toMatch(/invalid or revoked/);
  });

  it('self_chat: message includes concrete fix instructions', () => {
    const msg = formatValidateError({ ok: false, reason: 'self_chat', detail: '1234567890' });
    expect(msg).toContain('1234567890');
    expect(msg).toContain('BOT_TOKEN prefix');
    expect(msg).toContain('/start');
    expect(msg).toContain('getUpdates');
  });

  it('chat_not_found: suggests /start', () => {
    const msg = formatValidateError({ ok: false, reason: 'chat_not_found', detail: '222' });
    expect(msg).toContain('222');
    expect(msg).toContain('/start');
  });

  it('bot_recipient: explains the user-vs-bot distinction', () => {
    const msg = formatValidateError({ ok: false, reason: 'bot_recipient', detail: '333' });
    expect(msg).toMatch(/bot/i);
    expect(msg).toMatch(/user/i);
    expect(msg).toContain('333');
  });

  it('network_error: includes the underlying detail', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'network_error',
      detail: 'ENOTFOUND api.telegram.org',
    });
    expect(msg).toContain('ENOTFOUND');
  });

  it('rate_limited: mentions retry', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'rate_limited',
      detail: 'Too Many Requests: retry after 5',
    });
    expect(msg).toMatch(/retry/i);
  });
});

// ---------------------------------------------------------------------------
// sendVoice tests
// Bot-side surface for the ElevenLabs voice-reply pipeline. We mock fetch
// and assert the resulting POST hits /sendVoice with a multipart form that
// has chat_id + voice file + the optional caption/duration/reply_markup
// fields. We do NOT round-trip a real OGG file — the audio.ts helper is
// covered separately; here we only verify the HTTP shape.
// ---------------------------------------------------------------------------
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('TelegramAPI.sendVoice', () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let voicePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-sendvoice-'));
    voicePath = join(tmpDir, 'test.ogg');
    // 4-byte placeholder. Telegram won't see it — fetch is mocked.
    writeFileSync(voicePath, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throws a clear error when the voice file does not exist', async () => {
    const api = new TelegramAPI('111:AAA');
    await expect(api.sendVoice('222', '/nonexistent/path/to/voice.ogg')).rejects.toThrow(
      /Voice file not found/,
    );
  });

  it('POSTs to /sendVoice with chat_id and voice form fields', async () => {
    let captured: { url: string; method: string; body: FormData } | null = null;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      captured = { url: String(input), method: init?.method, body: init?.body };
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 99 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendVoice('222', voicePath);

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.telegram.org/bot111:AAA/sendVoice');
    expect(captured!.method).toBe('POST');
    expect(captured!.body).toBeInstanceOf(FormData);
    expect(captured!.body.get('chat_id')).toBe('222');
    expect(captured!.body.get('voice')).toBeInstanceOf(Blob);
  });

  it('includes caption and duration when provided', async () => {
    let captured: { body: FormData } | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      captured = { body: init?.body };
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as any;

    const api = new TelegramAPI('111:AAA');
    await api.sendVoice('222', voicePath, 'Morning brief', 12.7);

    expect(captured!.body.get('caption')).toBe('Morning brief');
    // duration is rounded to the nearest integer second
    expect(captured!.body.get('duration')).toBe('13');
  });

  it('omits duration when not provided or non-positive', async () => {
    let captured: { body: FormData } | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      captured = { body: init?.body };
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as any;

    const api = new TelegramAPI('111:AAA');
    await api.sendVoice('222', voicePath);
    expect(captured!.body.get('duration')).toBeNull();

    captured = null;
    await api.sendVoice('222', voicePath, undefined, 0);
    expect(captured!.body.get('duration')).toBeNull();
  });

  it('surfaces Telegram API errors with the description', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, description: 'Bad Request: file is too big' }),
        { status: 400 },
      ),
    ) as any;

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendVoice('222', voicePath)).rejects.toThrow(
      /Telegram API error: Bad Request: file is too big/,
    );
  });

  it('surfaces a clear timeout error when fetch aborts', async () => {
    globalThis.fetch = vi.fn(
      (_input: any, init?: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as any;

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendVoice('222', voicePath)).rejects.toThrow(/timed out after 60s: sendVoice/);
  }, 70000);
});
