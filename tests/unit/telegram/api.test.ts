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
