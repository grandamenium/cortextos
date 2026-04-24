import { describe, it, expect, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

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

describe('TelegramAPI.setMessageReaction', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts to setMessageReaction with the 👍 emoji by default', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as any;

    const api = new TelegramAPI('123:TEST');
    const res = await api.setMessageReaction(42, 999);

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/setMessageReaction$/);
    expect(calls[0].body).toEqual({
      chat_id: 42,
      message_id: 999,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
  });

  it('sends an empty reaction array when emoji is empty (clears reaction)', async () => {
    const calls: Array<{ body: any }> = [];
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as any;

    const api = new TelegramAPI('123:TEST');
    await api.setMessageReaction('42', 999, '');

    expect(calls[0].body).toEqual({
      chat_id: '42',
      message_id: 999,
      reaction: [],
    });
  });

  it('throws a Telegram API error when the response is not ok', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: 'REACTION_INVALID' }), { status: 400 }),
    ) as any;

    const api = new TelegramAPI('123:TEST');
    await expect(api.setMessageReaction(42, 1, '🎉')).rejects.toThrow(/REACTION_INVALID/);
  });
});
