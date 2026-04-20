import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAPI, TELEGRAM_MAX_LEN } from '../../../src/telegram/api';

// Minimal fetch-stub: queue responses, record request bodies. Matches
// the pattern in send-message.test.ts so the suites don't drift.
type MockResponse = { status: number; body: any };
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
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => next.body,
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  console.warn = originalWarn;
  vi.unstubAllGlobals();
});

describe('sendMessage multi-chunk counter suffix', () => {
  it('single-chunk message: no counter appended', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', 'short message');

    expect(callLog).toHaveLength(1);
    expect(callLog[0].body.text).toBe('short message');
    // Not "short message (1/1)" — single-chunk messages must be unchanged.
    expect(callLog[0].body.text).not.toMatch(/\(1\/1\)/);
  });

  it('empty-string message: still POSTs once, no counter', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', '');

    expect(callLog).toHaveLength(1);
    expect(callLog[0].body.text).toBe('');
  });

  it('two-chunk split: each gets (1/2) and (2/2)', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    // 6000 chars of the same char splits into exactly 2 chunks at the
    // 4086-char window (4096 minus the 10-char counter reservation).
    const longText = 'x'.repeat(6000);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', longText);

    expect(callLog).toHaveLength(2);
    expect(callLog[0].body.text.endsWith('\n\n(1/2)')).toBe(true);
    expect(callLog[1].body.text.endsWith('\n\n(2/2)')).toBe(true);
    // Concatenating the stripped chunks must give back the original text.
    const stripCounter = (t: string) => t.replace(/\n\n\(\d+\/\d+\)$/, '');
    const joined = callLog.map((c) => stripCounter(c.body.text)).join('');
    expect(joined).toBe(longText);
  });

  it('three-chunk split: (1/3), (2/3), (3/3)', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 3 } } });

    // 9000 chars at a 4086 split window lands in 3 chunks.
    const longText = 'y'.repeat(9000);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', longText);

    expect(callLog).toHaveLength(3);
    expect(callLog[0].body.text.endsWith('\n\n(1/3)')).toBe(true);
    expect(callLog[1].body.text.endsWith('\n\n(2/3)')).toBe(true);
    expect(callLog[2].body.text.endsWith('\n\n(3/3)')).toBe(true);
  });

  it('every chunk (including counter suffix) fits within TELEGRAM_MAX_LEN', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 3 } } });

    const longText = 'z'.repeat(9000);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', longText);

    for (const call of callLog) {
      expect(call.body.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
    }
  });

  it('counter uses the POST-split total, not a pre-computed guess', async () => {
    // Paragraph-aware split: two natural paragraphs around 3000 chars each
    // fall into two chunks, not three. The counter must reflect "/2" not "/3".
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    const text = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', text);

    expect(callLog).toHaveLength(2);
    expect(callLog[0].body.text).toMatch(/\(1\/2\)$/);
    expect(callLog[1].body.text).toMatch(/\(2\/2\)$/);
    expect(callLog[1].body.text).not.toMatch(/\(2\/3\)$/);
  });

  it('last chunk still carries replyMarkup; earlier chunks do not', async () => {
    queue({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    queue({ status: 200, body: { ok: true, result: { message_id: 2 } } });

    const text = 'a'.repeat(6000);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage('chat1', text, { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] });

    expect(callLog).toHaveLength(2);
    expect(callLog[0].body).not.toHaveProperty('reply_markup');
    expect(callLog[1].body.reply_markup).toBeTruthy();
  });
});
