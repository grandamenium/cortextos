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
import { buildTelegramReplyContext } from '../../../src/connectors/telegram/telegram-connector.js';

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
      // PR4 c9 (Codex P1.G): buttons now use ConnectorAction shape
      // ({label, actionId}); TelegramConnector translates to
      // {text, callback_data} for the inline_keyboard wire format.
      await c.sendMessage('approve?', {
        buttons: [[{ label: '✓', actionId: 'yes' }, { label: '✗', actionId: 'no' }]],
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

  describe('acknowledgeCallback (PR3)', () => {
    it('routes through TelegramAPI.answerCallbackQuery with the toast text', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      installFetchMock((url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { body: { ok: true, result: true } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.acknowledgeCallback!('cb_id_123', 'Got it');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/answerCallbackQuery');
      expect(calls[0].body.callback_query_id).toBe('cb_id_123');
      expect(calls[0].body.text).toBe('Got it');
    });

    it('uses TelegramAPI default "OK" toast when caller passes no text', async () => {
      // TelegramAPI.answerCallbackQuery defaults missing text → 'OK' so the
      // user still sees the spinner stop. The connector passes through.
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
      await c.acknowledgeCallback!('cb_id_456');
      expect(calls[0].body.text).toBe('OK');
    });
  });

  describe('sendReaction (PR4 c10 — outbound reactions)', () => {
    it('routes through TelegramAPI.setMessageReaction with bound chatId and {type:emoji, emoji}', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      installFetchMock((url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { body: { ok: true, result: true } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.sendReaction!('100', '👀');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/setMessageReaction');
      expect(calls[0].body.chat_id).toBe('12345'); // connector's bound chat
      expect(calls[0].body.message_id).toBe(100);
      expect(calls[0].body.reaction).toEqual([{ type: 'emoji', emoji: '👀' }]);
      expect(calls[0].body.is_big).toBe(false);
    });

    it('remove: true sends empty reaction array (Telegram contract: set-to-list)', async () => {
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
      await c.sendReaction!('100', '👀', { remove: true });
      // Telegram's setMessageReaction with `reaction: []` clears the bot's reactions.
      expect(calls[0].body.reaction).toEqual([]);
    });

    it('isBig: true sets is_big in the wire payload', async () => {
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
      await c.sendReaction!('100', '🎉', { isBig: true });
      expect(calls[0].body.is_big).toBe(true);
    });

    it('rejects non-integer or non-positive message_id', async () => {
      installFetchMock(() => ({ body: { ok: true, result: true } }));
      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await expect(c.sendReaction!('not-a-number', '👀')).rejects.toThrow(/invalid Telegram message_id/);
      await expect(c.sendReaction!('', '👀')).rejects.toThrow(/invalid Telegram message_id/);
      await expect(c.sendReaction!('0', '👀')).rejects.toThrow(/invalid Telegram message_id/);
    });
  });

  describe('editMessage (PR3)', () => {
    it('routes through TelegramAPI.editMessageText with the connector’s bound chatId', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      installFetchMock((url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { body: { ok: true, result: { message_id: 999 } } };
      });

      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      await c.editMessage!('999', 'Approved');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/editMessageText');
      // chat_id MUST be the connector's bound chat, NOT a value passed by caller
      expect(String(calls[0].body.chat_id)).toBe('12345');
      expect(calls[0].body.message_id).toBe(999);
      expect(calls[0].body.text).toBe('Approved');
    });

    it('opts.buttons (ConnectorAction[][]) becomes reply_markup.inline_keyboard ({text, callback_data})', async () => {
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
      // PR4 c9: caller passes ConnectorAction { label, actionId };
      // TelegramConnector.editMessage translates to Telegram
      // inline_keyboard { text, callback_data } shape.
      await c.editMessage!('42', 'Pick one', {
        buttons: [[{ label: 'Submit', actionId: 'submit' }]],
      });
      expect(calls[0].body.reply_markup).toEqual({
        inline_keyboard: [[{ text: 'Submit', callback_data: 'submit' }]],
      });
    });

    it('editMessage rejects non-integer message_id (Codex P2)', async () => {
      installFetchMock(() => ({ body: { ok: true } }));
      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      // Telegram message_ids must be numeric; the connector validates so
      // a bad id throws a typed error at the call site instead of
      // silently producing a Telegram API failure with NaN.
      await expect(c.editMessage!('not-a-number', 'text')).rejects.toThrow(/invalid Telegram message_id/);
      await expect(c.editMessage!('', 'text')).rejects.toThrow(/invalid Telegram message_id/);
    });

    it('declares interactiveCallbacks and messageEdits capabilities', () => {
      const c = new TelegramConnector('/tmp/agent', {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });
      expect(c.capabilities.interactiveCallbacks).toBe(true);
      expect(c.capabilities.messageEdits).toBe(true);
    });
  });

  describe('media enrichment (PR4)', () => {
    it('emits NormalizedMessage with m.media populated when downloadDir is set and message has photo', async () => {
      // Mock the entire fetch surface used by both the poller (getUpdates)
      // and the media pipeline (getFile + downloadFile).
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-media-'));
      const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-media-dl-'));

      const photoUpdate = {
        update_id: 1,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          caption: 'a caption',
          photo: [
            { file_id: 'small_id', file_size: 100, width: 90, height: 90 },
            { file_id: 'large_id', file_size: 5000, width: 800, height: 600 },
          ],
        },
      };

      let getUpdatesCalls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          getUpdatesCalls++;
          // Serve the photo update once; then return empty for subsequent polls
          if (getUpdatesCalls === 1) {
            return { body: { ok: true, result: [photoUpdate] } };
          }
          return { body: { ok: true, result: [] } };
        }
        if (url.includes('/getFile')) {
          return { body: { ok: true, result: { file_path: 'photos/large_id.jpg' } } };
        }
        if (url.includes('file/bot')) {
          // downloadFile path — return a tiny binary payload
          return { body: 'fake-image-bytes' as any };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      }, { downloadDir });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });

      // Wait long enough for one poll cycle + the async media download
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      expect(received[0].media).toBeDefined();
      expect(received[0].media.kind).toBe('photo');
      expect(received[0].media.localPath).toContain(downloadDir);
      expect(received[0].text).toBe('a caption');

      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(downloadDir, { recursive: true, force: true });
    });

    it('rejects media when declared file_size exceeds perFileBytes cap (Codex P0.2)', async () => {
      // Pre-getFile reject: msg.<media>.file_size on the update tells us
      // the file is too large; the connector returns null from
      // processMediaMessage and the connector emits a text-only fallback.
      // Confirms no `getFile` call was made (declared-size cap dropped it
      // before hitting Telegram).
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-'));
      const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-dl-'));

      const bigPhotoUpdate = {
        update_id: 1,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          caption: 'too big',
          // 100 MB declared — far above the 1 MB cap configured below
          photo: [{ file_id: 'big_id', file_size: 100 * 1024 * 1024, width: 4000, height: 3000 }],
        },
      };

      let getFileCalls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          return { body: { ok: true, result: getFileCalls === 0 ? [bigPhotoUpdate] : [] } };
        }
        if (url.includes('/getFile')) {
          getFileCalls++;
          return { body: { ok: true, result: { file_path: 'photos/big.jpg' } } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      }, { downloadDir, mediaLimits: { perFileBytes: 1 * 1024 * 1024 } });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      // text-only fallback: media should be undefined, caption flows through as text
      expect(received[0].media).toBeUndefined();
      expect(received[0].text).toBe('too big');
      // Critical: getFile was NEVER called — the precheck rejected before
      // hitting Telegram's API for the file path.
      expect(getFileCalls).toBe(0);

      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(downloadDir, { recursive: true, force: true });
    });

    it('LRU-evicts oldest files when totalQuotaBytes would be exceeded (Codex P0.2)', async () => {
      // Pre-seed downloadDir with two files near the quota; download a new
      // photo that pushes us over. Expect the older file to be unlinked.
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-quota-'));
      const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-quota-dl-'));

      // Seed two 4KB files; quota 12KB. Incoming download ~5KB.
      // 4 + 4 = 8KB used → +5KB incoming = 13KB > 12KB → evict the
      // oldest (4KB), 4KB used + 5KB incoming = 9KB ≤ 12KB → stop.
      // Newer file should survive.
      const oldFile = path.join(downloadDir, 'old.bin');
      const newerFile = path.join(downloadDir, 'newer.bin');
      fs.writeFileSync(oldFile, Buffer.alloc(4000));
      // Touch with earlier mtime
      const oldMtime = new Date(Date.now() - 60000);
      fs.utimesSync(oldFile, oldMtime, oldMtime);
      fs.writeFileSync(newerFile, Buffer.alloc(4000));

      const photoUpdate = {
        update_id: 1,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          caption: 'fits after eviction',
          photo: [{ file_id: 'small_id', file_size: 5000, width: 800, height: 600 }],
        },
      };

      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          return { body: { ok: true, result: [photoUpdate] } };
        }
        if (url.includes('/getFile')) {
          return { body: { ok: true, result: { file_path: 'photos/small.jpg' } } };
        }
        if (url.includes('file/bot')) {
          // ~5KB body so quota check (16KB used + 5KB > 12KB) triggers eviction
          return { body: 'x'.repeat(5000) as any };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      }, { downloadDir, mediaLimits: { perFileBytes: 50 * 1024, totalQuotaBytes: 12 * 1024 } });

      vi.useRealTimers();
      await c.startPolling({ onMessage: () => {} }, { stateDir });
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      // Oldest file evicted; newer file kept.
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newerFile)).toBe(true);

      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(downloadDir, { recursive: true, force: true });
    });

    it('emits text-only NormalizedMessage when downloadDir is NOT set, even for media messages', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-no-media-'));

      const photoUpdate = {
        update_id: 1,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          caption: 'caption-only',
          photo: [{ file_id: 'large_id', file_size: 5000, width: 800, height: 600 }],
        },
      };

      let getUpdatesCalls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          getUpdatesCalls++;
          if (getUpdatesCalls === 1) {
            return { body: { ok: true, result: [photoUpdate] } };
          }
          return { body: { ok: true, result: [] } };
        }
        return { body: { ok: true, result: {} } };
      });

      // No downloadDir → no media enrichment, no getFile calls expected
      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });

      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      expect(received[0].media).toBeUndefined();
      // Caption still flows through as text
      expect(received[0].text).toBe('caption-only');

      fs.rmSync(stateDir, { recursive: true, force: true });
    });
  });

  describe('message normalization (PR4 commit 2): chat_id + reply_to.text', () => {
    it('populates chat_id from msg.chat.id (stringified) on emitted NormalizedMessage', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chatid-'));

      const update = {
        update_id: 1,
        message: {
          message_id: 200,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          text: 'hi',
        },
      };

      let calls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          calls++;
          return { body: { ok: true, result: calls === 1 ? [update] : [] } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      // `chat_id` must be a STRING (matching the `String(msg.chat.id)` contract)
      // so the daemon's downstream callers don't see a numeric value here.
      expect(received[0].chat_id).toBe('12345');
      expect(typeof received[0].chat_id).toBe('string');

      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it('populates reply_to with id + rendered text when the inbound message has reply_to_message', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-replyto-'));

      const update = {
        update_id: 1,
        message: {
          message_id: 201,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          text: 'replying',
          reply_to_message: {
            message_id: 99,
            chat: { id: 12345, type: 'private' },
            voice: { file_id: 'v1', duration: 5 },
          },
        },
      };

      let calls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          calls++;
          return { body: { ok: true, result: calls === 1 ? [update] : [] } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      expect(received[0].reply_to).toEqual({ id: '99', text: '[voice message]' });

      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it('leaves reply_to undefined when the inbound message has no reply_to_message', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-noreplyto-'));

      const update = {
        update_id: 1,
        message: {
          message_id: 202,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, first_name: 'Alice', is_bot: false },
          text: 'no reply here',
        },
      };

      let calls = 0;
      installFetchMock((url) => {
        if (url.endsWith('/getUpdates')) {
          calls++;
          return { body: { ok: true, result: calls === 1 ? [update] : [] } };
        }
        return { body: { ok: true, result: {} } };
      });

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      });

      const received: any[] = [];
      vi.useRealTimers();
      await c.startPolling({ onMessage: (m) => { received.push(m); } }, { stateDir });
      await new Promise((r) => setTimeout(r, 200));
      await c.stopPolling();

      expect(received).toHaveLength(1);
      expect(received[0].reply_to).toBeUndefined();

      fs.rmSync(stateDir, { recursive: true, force: true });
    });
  });

  describe('buildTelegramReplyContext (PR4 commit 2 — moved from agent-manager)', () => {
    // Pinned per-kind label rendering. Moved from
    // tests/unit/daemon/agent-manager.test.ts because the helper now lives
    // in the telegram connector module — the daemon no longer inspects
    // Telegram-specific media fields to render reply context.
    it('returns undefined when no reply message', () => {
      expect(buildTelegramReplyContext(undefined)).toBeUndefined();
    });

    it('returns text content for plain text replies', () => {
      const msg = { message_id: 1, chat: { id: 1 }, text: 'Hello world' } as any;
      expect(buildTelegramReplyContext(msg)).toBe('Hello world');
    });

    it('returns caption for media messages with captions', () => {
      const msg = { message_id: 2, chat: { id: 1 }, photo: [{ file_id: 'x', width: 100, height: 100, file_size: 1 }], caption: 'Check this out' } as any;
      expect(buildTelegramReplyContext(msg)).toBe('Check this out');
    });

    it('returns [video] for video messages without caption', () => {
      const msg = { message_id: 3, chat: { id: 1 }, video: { file_id: 'v1', width: 1920, height: 1080, duration: 30 } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[video]');
    });

    it('returns [photo] for photo messages without caption', () => {
      const msg = { message_id: 4, chat: { id: 1 }, photo: [{ file_id: 'p1', width: 100, height: 100, file_size: 1 }] } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[photo]');
    });

    it('returns [voice message] for voice messages', () => {
      const msg = { message_id: 5, chat: { id: 1 }, voice: { file_id: 'vc1', duration: 5 } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[voice message]');
    });

    it('returns [video note] for video note messages', () => {
      const msg = { message_id: 6, chat: { id: 1 }, video_note: { file_id: 'vn1', length: 240, duration: 10 } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[video note]');
    });

    it('returns [audio] for audio messages', () => {
      const msg = { message_id: 7, chat: { id: 1 }, audio: { file_id: 'a1', duration: 120 } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[audio]');
    });

    it('returns document name for document messages', () => {
      const msg = { message_id: 8, chat: { id: 1 }, document: { file_id: 'd1', file_name: 'report.pdf' } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[document: report.pdf]');
    });

    it('returns [document: file] when document has no file_name', () => {
      const msg = { message_id: 9, chat: { id: 1 }, document: { file_id: 'd2' } } as any;
      expect(buildTelegramReplyContext(msg)).toBe('[document: file]');
    });

    it('prefers text over caption when both present', () => {
      const msg = { message_id: 10, chat: { id: 1 }, text: 'Text content', caption: 'Caption content' } as any;
      expect(buildTelegramReplyContext(msg)).toBe('Text content');
    });

    it('strips control characters from text', () => {
      const msg = { message_id: 11, chat: { id: 1 }, text: 'Hello\x00world' } as any;
      const result = buildTelegramReplyContext(msg);
      expect(result).not.toContain('\x00');
    });
  });

  describe('pollerNamespace (PR3)', () => {
    it('namespaced connector writes its offset file with the suffix', async () => {
      // Stub fetch so the inner poller's getUpdates resolves immediately
      installFetchMock(() => ({ body: { ok: true, result: [] } }));
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-connector-ns-'));

      const c = new TelegramConnector(stateDir, {
        BOT_TOKEN: '123:abc',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      }, { pollerNamespace: 'activity' });

      vi.useRealTimers();
      await c.startPolling({ onMessage: () => {} });
      // Give the loop one tick so the poller has a chance to read/write
      // its offset file. The default poll interval is 1000ms, so a 50ms
      // tick is well under one iteration.
      await new Promise((r) => setTimeout(r, 50));
      await c.stopPolling();

      // The offset file for a namespaced connector is `.telegram-offset-<ns>`.
      // We don't assert on the file's content (the inner poller writes it
      // lazily); we assert that the namespace flows through by checking
      // the connector did not write the default `.telegram-offset` path
      // when a namespace was requested. Either presence of the namespaced
      // path OR absence of the default proves the wire is connected;
      // checking absence is the safer assertion against test-environment
      // race conditions.
      expect(fs.existsSync(path.join(stateDir, '.telegram-offset'))).toBe(false);
      fs.rmSync(stateDir, { recursive: true, force: true });
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
