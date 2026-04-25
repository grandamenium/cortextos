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

describe('TelegramAPI.sendMessage HTML mode', () => {
  it('sends with parse_mode=HTML by default', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 111 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', 'hello world');

    expect(result?.result?.message_id).toBe(111);
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/sendMessage');
    expect(callLog[0].body.parse_mode).toBe('HTML');
    expect(warnLog).toHaveLength(0);
  });

  it('converts *bold* to <b>bold</b>', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', '*hello world*');
    expect(callLog[0].body.text).toBe('<b>hello world</b>');
  });

  it('converts `inline code` to <code>inline code</code>', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'run `--runtime` flag');
    expect(callLog[0].body.text).toBe('run <code>--runtime</code> flag');
  });

  it('converts fenced code blocks to <pre><code>', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', '```\nnpm install\n```');
    expect(callLog[0].body.text).toContain('<pre><code>');
    expect(callLog[0].body.text).toContain('npm install');
    expect(callLog[0].body.text).toContain('</code></pre>');
  });

  it('HTML-escapes & < > in raw text', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'cost is $100 & more <info>');
    expect(callLog[0].body.text).toBe('cost is $100 &amp; more &lt;info&gt;');
  });

  it('$ signs and numbers are not dropped', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', '$50 budget at $100 hard-block');
    expect(callLog[0].body.text).toBe('$50 budget at $100 hard-block');
  });

  it('converts [text](url) to <a href="url">text</a>', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'check [the docs](https://example.com/docs)');
    expect(callLog[0].body.text).toBe('check <a href="https://example.com/docs">the docs</a>');
  });

  it('underscores in filenames/flags are not dropped', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'file_name.ts and CTX_ROOT env');
    // snake_case should NOT be converted to italic
    expect(callLog[0].body.text).toBe('file_name.ts and CTX_ROOT env');
  });

  it('non-parse error (401 unauthorized) fails fast, no retry', async () => {
    queue({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });

    const api = new TelegramAPI('999:BAD');
    await expect(api.sendMessage('chat1', 'test')).rejects.toThrow(/Unauthorized/);

    expect(callLog).toHaveLength(1);
    expect(warnLog).toHaveLength(0);
  });

  it('opt-in plain-text mode: no parse_mode field, no Markdown conversion', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 333 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage(
      'chat1',
      '*not bold* `not code`',
      undefined,
      { parseMode: null },
    );

    expect(result?.result?.message_id).toBe(333);
    expect(callLog).toHaveLength(1);
    expect(callLog[0].body).not.toHaveProperty('parse_mode');
    // Content is HTML-escaped but not Markdown-converted
    expect(callLog[0].body.text).toBe('*not bold* `not code`');
    expect(warnLog).toHaveLength(0);
  });

  it('chunked long messages: splits at newline boundaries, not raw char offsets', async () => {
    // Build a message with clear paragraph structure so we can verify split point
    const para = 'x'.repeat(2000) + '\n\n';
    const longText = para + para + 'z'.repeat(500); // ~4500 chars total
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage('chat1', longText, undefined, { parseMode: null });

    expect(callLog).toHaveLength(2);
    // Verify the split happened at a newline (first chunk ends with \n\n or similar)
    expect(callLog[0].body.text.endsWith('\n\n') || callLog[0].body.text.endsWith('\n')).toBe(true);
    expect(result?.result?.message_id).toBe(2);
  });

  it('chunked long messages: all chunks use parse_mode=HTML when not plain-text', async () => {
    const longText = 'a'.repeat(5000);
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', longText);

    expect(callLog).toHaveLength(2);
    for (const call of callLog) {
      expect(call.body.parse_mode).toBe('HTML');
    }
  });

  it('chunked long messages: all chunks omit parse_mode when plain-text', async () => {
    const longText = 'b'.repeat(5000);
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', longText, undefined, { parseMode: null });

    expect(callLog).toHaveLength(2);
    for (const call of callLog) {
      expect(call.body).not.toHaveProperty('parse_mode');
    }
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
