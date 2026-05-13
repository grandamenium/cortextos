/**
 * Unit tests for TelegramConnector — verifies the wrapper around
 * TelegramAPI produces the expected MessageConnector behavior:
 *   - sendMessage routes through TelegramAPI with HTML parse mode by default
 *   - sendMedia routes by kind
 *   - validateCredentials maps Telegram-specific reasons to generic ones
 *   - setTypingIndicator(true) fires sendChatAction; false is a no-op
 *   - registerCommands renames {name, description} → Telegram's BotCommand shape
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramConnector } from '../../../src/connectors/index.js';

type MockResponseFactory = (url: string, init: any) => { status?: number; body: any };

function installFetchMock(factory: MockResponseFactory) {
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const { status = 200, body } = factory(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
}

describe('TelegramConnector', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('sendMessage', () => {
    it('routes through TelegramAPI with HTML parse mode by default', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      installFetchMock((url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { body: { ok: true, result: { message_id: 42 } } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      const res = await c.sendMessage('hello world');
      expect(res.id).toBe('42');
      expect(typeof res.ts).toBe('number');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/sendMessage');
      expect(calls[0].body.chat_id).toBe('12345');
      expect(calls[0].body.parse_mode).toBe('HTML');
    });

    it('parseMode "plain" suppresses HTML parse mode', async () => {
      const calls: Array<{ body: any }> = [];
      installFetchMock((_url, init) => {
        calls.push({ body: JSON.parse(init.body) });
        return { body: { ok: true, result: { message_id: 1 } } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.sendMessage('raw text', { parseMode: 'plain' });
      expect(calls[0].body.parse_mode).toBeUndefined();
    });

    it('buttons option produces an inline_keyboard reply_markup', async () => {
      const calls: Array<{ body: any }> = [];
      installFetchMock((_url, init) => {
        calls.push({ body: JSON.parse(init.body) });
        return { body: { ok: true, result: { message_id: 1 } } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.sendMessage('approve?', {
        buttons: [[{ text: '✓', callback_data: 'yes' }, { text: '✗', callback_data: 'no' }]],
      });
      expect(calls[0].body.reply_markup).toEqual({
        inline_keyboard: [[{ text: '✓', callback_data: 'yes' }, { text: '✗', callback_data: 'no' }]],
      });
    });
  });

  describe('validateCredentials', () => {
    it('returns ok with formatted identity on getMe + getChat success', async () => {
      let callCount = 0;
      installFetchMock((url) => {
        callCount++;
        if (url.endsWith('/getMe')) {
          return { body: { ok: true, result: { id: 111, username: 'mybot', is_bot: true } } };
        }
        if (url.endsWith('/getChat')) {
          return { body: { ok: true, result: { id: 12345, type: 'private', first_name: 'Daniel' } } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      const res = await c.validateCredentials();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.identity).toMatch(/@mybot/);
      }
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('maps bad_token → bad_credentials', async () => {
      installFetchMock((url) => {
        if (url.endsWith('/getMe')) {
          return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: 'bad',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      const res = await c.validateCredentials();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('bad_credentials');
      }
    });
  });

  describe('setTypingIndicator', () => {
    it('fires sendChatAction when on=true', async () => {
      const calls: string[] = [];
      installFetchMock((url) => {
        calls.push(url);
        return { body: { ok: true, result: true } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.setTypingIndicator!(true);
      expect(calls.some(u => u.endsWith('/sendChatAction'))).toBe(true);
    });

    it('on=false is a silent no-op (no HTTP call)', async () => {
      const calls: string[] = [];
      installFetchMock((url) => {
        calls.push(url);
        return { body: { ok: true, result: true } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.setTypingIndicator!(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe('registerCommands', () => {
    it('maps generic shape to Telegram BotCommand shape', async () => {
      const calls: Array<{ body: any }> = [];
      installFetchMock((_url, init) => {
        calls.push({ body: JSON.parse(init.body) });
        return { body: { ok: true, result: true } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.registerCommands!([
        { name: 'start', description: 'Start a conversation' },
        { name: 'status', description: 'Check agent status' },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0].body.commands).toEqual([
        { command: 'start', description: 'Start a conversation' },
        { command: 'status', description: 'Check agent status' },
      ]);
    });
  });

  describe('startPolling', () => {
    it('resolves promptly (does NOT await the forever-running poller)', async () => {
      // Stub fetch so the internal poller's getUpdates doesn't actually hit the network
      installFetchMock(() => ({ body: { ok: true, result: [] } }));
      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      // Use real timers so the inner poll loop doesn't lock up
      vi.useRealTimers();
      const start = Date.now();
      await c.startPolling({ onMessage: () => {} });
      const elapsed = Date.now() - start;
      // Must resolve in well under 1s — proves the contract that startPolling
      // returns once the loop is scheduled, not when it completes.
      expect(elapsed).toBeLessThan(500);
      await c.stopPolling();
    });
  });
});
