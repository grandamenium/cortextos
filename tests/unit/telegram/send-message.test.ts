import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// Shared fetch-stub infrastructure. Each test queues responses; the stub
// records call details so we can assert on payload shapes and call counts.
type MockResponse = { status: number; body: any } | { throws: Error };

let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; body: any }> = [];
let warnLog: string[] = [];
let originalWarn: typeof console.warn;

function queue(r: MockResponse): void {
  responseQueue.push(r);
}

beforeEach(() => {
  responseQueue = [];
  callLog = [];
  warnLog = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
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
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  console.warn = originalWarn;
});

// Strip out the mandatory rate-limit delay so the test suite stays fast.
// sendMessage() calls rateLimit() which sleeps 0-1000ms per send. Since we
// only make small test messages the per-chat memory happens not to trip the
// limit after the first call, but the first call still takes ~0ms.

describe('TelegramAPI.sendMessage parse-mode retry', () => {
  it('happy path: well-formed markdown sends once with parse_mode=Markdown, no retry, no warning', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 111 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', 'hello world');

    expect(result?.result?.message_id).toBe(111);
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/sendMessage');
    expect(callLog[0].body.parse_mode).toBe('Markdown');
    expect(callLog[0].body.text).toBe('hello world');
    expect(warnLog).toHaveLength(0);
  });

  it('parse-entity error triggers one-shot retry with parse_mode omitted', async () => {
    // First call: Telegram parse failure. Second call: success.
    queue({
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 42",
      },
    });
    queue({ status: 200, body: { ok: true, result: { message_id: 222 } } });

    const fallbackReasons: string[] = [];
    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', 'prose with a dangling _underscore', undefined, {
      onParseFallback: (reason) => fallbackReasons.push(reason),
    });

    expect(result?.result?.message_id).toBe(222);
    expect(callLog).toHaveLength(2);
    // First attempt used Markdown:
    expect(callLog[0].body.parse_mode).toBe('Markdown');
    // Retry attempt has NO parse_mode field:
    expect(callLog[1].body).not.toHaveProperty('parse_mode');
    // Same chat_id and text on both attempts:
    expect(callLog[1].body.chat_id).toBe('chat1');
    expect(callLog[1].body.text).toBe('prose with a dangling _underscore');
    // Exactly one warning emitted, plus the caller's hook fired once:
    expect(warnLog).toHaveLength(1);
    expect(warnLog[0]).toMatch(/parse-mode fallback for chat chat1/);
    expect(fallbackReasons).toHaveLength(1);
    expect(fallbackReasons[0]).toMatch(/can'?t parse entities/i);
  });

  it('parse-entity error AND retry also fails: sendMessage rethrows, no infinite loop', async () => {
    queue({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    });
    queue({
      status: 500,
      body: { ok: false, error_code: 500, description: 'Internal Server Error' },
    });

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendMessage('chat1', 'bad text')).rejects.toThrow(/Internal Server Error/);

    // Exactly 2 calls — the initial attempt and one retry. Never more.
    expect(callLog).toHaveLength(2);
    // Warning was still emitted before the retry attempt (observability).
    expect(warnLog).toHaveLength(1);
  });

  it('non-parse error (401 unauthorized) does NOT trigger retry, fails fast', async () => {
    queue({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });

    const api = new TelegramAPI('999:BAD');
    await expect(api.sendMessage('chat1', 'test')).rejects.toThrow(/Unauthorized/);

    // Only ONE call — 401 is not recoverable via parse-mode removal.
    expect(callLog).toHaveLength(1);
    expect(warnLog).toHaveLength(0);
  });

  it('opt-in plain-text mode: first call has no parse_mode, no retry, no warning', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 333 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage(
      'chat1',
      'literal _underscores_ and *asterisks* all over',
      undefined,
      { parseMode: null },
    );

    expect(result?.result?.message_id).toBe(333);
    expect(callLog).toHaveLength(1);
    expect(callLog[0].body).not.toHaveProperty('parse_mode');
    expect(warnLog).toHaveLength(0);
  });

  it('opt-in plain-text mode does NOT retry even if Telegram returns a parse-like error string', async () => {
    // Edge case: if the caller is in plain-text mode and Telegram still
    // returns an error that mentions "parse entities" (shouldn't happen
    // in practice but guards the logic), we must NOT retry — there's no
    // further parse_mode to strip.
    queue({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities (weird edge case)" },
    });

    const api = new TelegramAPI('111:AAA');
    await expect(
      api.sendMessage('chat1', 'weird', undefined, { parseMode: null }),
    ).rejects.toThrow(/parse entities/);

    expect(callLog).toHaveLength(1);
    expect(warnLog).toHaveLength(0);
  });

  it('chunked long messages: every chunk respects parseMode=null when opted in', async () => {
    // 9000-char message → 3 chunks at 4096-char boundary.
    const longText = 'x'.repeat(9000);
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 3 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', longText, undefined, { parseMode: null });

    expect(callLog).toHaveLength(3);
    for (const call of callLog) {
      expect(call.body).not.toHaveProperty('parse_mode');
    }
    // Result is the last chunk's response (backwards-compatible with the
    // pre-patch behavior).
    expect(result?.result?.message_id).toBe(3);
  });

  it('chunked long messages: parse error on chunk 2 triggers retry for that chunk only', async () => {
    const longText = 'y'.repeat(9000);
    // chunk 1 ok, chunk 2 parse-fails then ok, chunk 3 ok.
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 3 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', longText);

    // 4 total calls: chunk1, chunk2-fail, chunk2-retry, chunk3
    expect(callLog).toHaveLength(4);
    expect(callLog[0].body.parse_mode).toBe('Markdown');
    expect(callLog[1].body.parse_mode).toBe('Markdown');
    expect(callLog[2].body).not.toHaveProperty('parse_mode'); // retry chunk 2
    expect(callLog[3].body.parse_mode).toBe('Markdown'); // chunk 3 still Markdown
    expect(result?.result?.message_id).toBe(3);
    // One warning for the one fallback.
    expect(warnLog).toHaveLength(1);
  });

  it('onParseFallback hook is called exactly once per fallback with the Telegram error message', async () => {
    queue({
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities at byte 99",
      },
    });
    queue({ status: 200, body: { ok: true, result: { message_id: 5 } } });

    const reasons: string[] = [];
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'bad', undefined, {
      onParseFallback: (r) => reasons.push(r),
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("can't parse entities at byte 99");
  });
});

describe('TelegramAPI.sendMessage self_chat runtime safety net', () => {
  it('emits a one-time console.warn when Telegram returns the bot-recipient 403', async () => {
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendMessage('777', 'hello')).rejects.toThrow(/bots can'?t send messages to bots/i);

    expect(warnLog).toHaveLength(1);
    const warn = warnLog[0];
    expect(warn).toContain('[telegram]');
    expect(warn).toContain('self_chat');
    expect(warn).toContain('chat_id=777');
    expect(warn).toContain('CHAT_ID');
    expect(warn).toContain('/start');
    // Must not leak any portion of the bot token.
    expect(warn).not.toContain('AAA');
    expect(warn).not.toContain('111:AAA');
  });

  it('does not re-warn for the same chat_id across repeated sendMessage calls in one process', async () => {
    for (let i = 0; i < 3; i++) {
      queue({
        status: 403,
        body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
      });
    }

    const api = new TelegramAPI('111:AAA');
    for (let i = 0; i < 3; i++) {
      await expect(api.sendMessage('777', `msg${i}`)).rejects.toThrow();
    }

    expect(warnLog).toHaveLength(1);
  });

  it('warns separately for distinct chat_ids', async () => {
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendMessage('777', 'a')).rejects.toThrow();
    await expect(api.sendMessage('888', 'b')).rejects.toThrow();

    expect(warnLog).toHaveLength(2);
    expect(warnLog[0]).toContain('chat_id=777');
    expect(warnLog[1]).toContain('chat_id=888');
  });

  it('does NOT warn on unrelated 403s', async () => {
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: 'Forbidden: user is deactivated' },
    });

    const api = new TelegramAPI('111:AAA');
    await expect(api.sendMessage('777', 'hi')).rejects.toThrow();

    expect(warnLog).toHaveLength(0);
  });

  it('throw behavior unchanged — the 403 still propagates to the caller', async () => {
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });

    const api = new TelegramAPI('111:AAA');
    let caught: Error | null = null;
    try {
      await api.sendMessage('777', 'x');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/bots can'?t send messages to bots/i);
  });
});
