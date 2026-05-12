import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  logOutboundMessage,
  logInboundMessage,
  recordInboundTelegram,
  cacheLastSent,
  readLastSent,
} from '../../../src/telegram/logging';
import { TelegramAPI } from '../../../src/telegram/api';
import type { BusPaths, TelegramMessage } from '../../../src/types';

describe('Telegram Logging', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-log-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('logOutboundMessage', () => {
    it('appends correct JSONL format', () => {
      logOutboundMessage(testDir, 'bot1', '12345', 'Hello world', 99);

      const logPath = join(testDir, 'logs', 'bot1', 'outbound-messages.jsonl');
      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.agent).toBe('bot1');
      expect(entry.chat_id).toBe('12345');
      expect(entry.text).toBe('Hello world');
      expect(entry.message_id).toBe(99);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('appends multiple entries', () => {
      logOutboundMessage(testDir, 'bot1', '111', 'first', 1);
      logOutboundMessage(testDir, 'bot1', '111', 'second', 2);

      const logPath = join(testDir, 'logs', 'bot1', 'outbound-messages.jsonl');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).text).toBe('first');
      expect(JSON.parse(lines[1]).text).toBe('second');
    });
  });

  describe('logInboundMessage', () => {
    it('appends with archived_at and agent', () => {
      const raw = { message_id: 42, text: 'hi', from: { id: 1 } };
      logInboundMessage(testDir, 'bot2', raw);

      const logPath = join(testDir, 'logs', 'bot2', 'inbound-messages.jsonl');
      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.message_id).toBe(42);
      expect(entry.text).toBe('hi');
      expect(entry.from).toEqual({ id: 1 });
      expect(entry.agent).toBe('bot2');
      expect(entry.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('recordInboundTelegram', () => {
    function buildPaths(ctxRoot: string, agent: string): BusPaths {
      return {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', agent),
        inflight: join(ctxRoot, 'inflight', agent),
        processed: join(ctxRoot, 'processed', agent),
        logDir: join(ctxRoot, 'logs', agent),
        stateDir: join(ctxRoot, 'state', agent),
        taskDir: join(ctxRoot, 'tasks'),
        approvalDir: join(ctxRoot, 'approvals'),
        analyticsDir: join(ctxRoot, 'analytics'),
        heartbeatDir: join(ctxRoot, 'heartbeats'),
      };
    }

    it('writes both the inbound JSONL row AND the telegram_received bus event', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      const msg: TelegramMessage = {
        message_id: 12345,
        date: 1714214400,
        from: { id: 6595584963, is_bot: false, first_name: 'Eros' },
        chat: { id: 6595584963, type: 'private' },
        text: 'Doe maar',
      };

      recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg);

      const inboundPath = join(testDir, 'logs', 'spark', 'inbound-messages.jsonl');
      const inboundEntry = JSON.parse(readFileSync(inboundPath, 'utf-8').trim());
      expect(inboundEntry).toMatchObject({
        message_id: 12345,
        from: 6595584963,
        from_name: 'Eros',
        chat_id: 6595584963,
        text: 'Doe maar',
        agent: 'spark',
      });

      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'spark', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry).toMatchObject({
        agent: 'spark',
        org: 'eros-os',
        category: 'message',
        event: 'telegram_received',
        severity: 'info',
        metadata: {
          chat_id: '6595584963',
          message_id: 12345,
          from_id: 6595584963,
          from_name: 'Eros',
          has_media: false,
          text_chars: 8,
        },
      });
    });

    it('marks has_media=true and uses caption length when the message carries a photo', () => {
      const paths = buildPaths(testDir, 'bolt');
      mkdirSync(paths.stateDir, { recursive: true });

      const msg: TelegramMessage = {
        message_id: 99,
        date: 1714214400,
        from: { id: 100, is_bot: false, first_name: 'Eros' },
        chat: { id: 100, type: 'private' },
        caption: 'screenshot of the dashboard',
        photo: [{ file_id: 'a', file_unique_id: 'b', width: 1, height: 1 }],
      };

      recordInboundTelegram(paths, testDir, 'bolt', 'eros-os', 'Eros', msg);

      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'bolt', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry.metadata.has_media).toBe(true);
      expect(eventEntry.metadata.text_chars).toBe('screenshot of the dashboard'.length);
    });

    it('still writes the JSONL row when the bus-event emit throws', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      // Force a logEvent failure: writing to a path under a regular file
      // (not a dir) makes mkdirSync recursive throw with EEXIST/ENOTDIR.
      writeFileSync(join(testDir, 'analytics'), 'i am a regular file, not a dir', 'utf-8');

      const msg: TelegramMessage = {
        message_id: 7,
        date: 1714214400,
        from: { id: 1, is_bot: false, first_name: 'Eros' },
        chat: { id: 1, type: 'private' },
        text: 'hi',
      };

      const logSpy = vi.fn();
      // Must not throw
      expect(() => {
        recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg, logSpy);
      }).not.toThrow();

      // JSONL still written.
      const inboundPath = join(testDir, 'logs', 'spark', 'inbound-messages.jsonl');
      const inboundEntry = JSON.parse(readFileSync(inboundPath, 'utf-8').trim());
      expect(inboundEntry.text).toBe('hi');

      // Failure surfaced through the log callback.
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('cacheLastSent / readLastSent', () => {
    it('writes and reads back text', () => {
      cacheLastSent(testDir, 'bot1', '999', 'cached message');
      const result = readLastSent(testDir, 'bot1', '999');
      expect(result).toBe('cached message');
    });

    it('overwrites previous cache', () => {
      cacheLastSent(testDir, 'bot1', '999', 'old');
      cacheLastSent(testDir, 'bot1', '999', 'new');
      expect(readLastSent(testDir, 'bot1', '999')).toBe('new');
    });

    it('returns null when file does not exist', () => {
      const result = readLastSent(testDir, 'bot1', '000');
      expect(result).toBeNull();
    });
  });
});

describe('TelegramAPI.sendPhoto', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-photo-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throws if image file does not exist', async () => {
    const api = new TelegramAPI('test-token');
    await expect(
      api.sendPhoto('123', '/nonexistent/image.jpg'),
    ).rejects.toThrow('Image file not found');
  });

  it('sends multipart form data with correct fields', async () => {
    // Create a fake image file
    const imagePath = join(testDir, 'test.jpg');
    writeFileSync(imagePath, 'fake-image-data');

    const api = new TelegramAPI('test-token');

    // Mock fetch
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 55 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await api.sendPhoto('123', imagePath, 'My caption', {
      inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]],
    });

    expect(result.ok).toBe(true);
    expect(result.result.message_id).toBe(55);

    // Verify fetch was called with correct URL and FormData
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendPhoto');
    expect(options.method).toBe('POST');

    // Verify it's a FormData body
    const body = options.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('123');
    expect(body.get('caption')).toBe('My caption');
    expect(body.get('reply_markup')).toBe(
      JSON.stringify({ inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] }),
    );
    // photo should be a Blob
    const photo = body.get('photo');
    expect(photo).toBeInstanceOf(Blob);
  });

  it('sends without optional fields when not provided', async () => {
    const imagePath = join(testDir, 'test.png');
    writeFileSync(imagePath, 'png-data');

    const api = new TelegramAPI('test-token');
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 56 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await api.sendPhoto('456', imagePath);

    const body = mockFetch.mock.calls[0][1].body as FormData;
    expect(body.get('chat_id')).toBe('456');
    expect(body.get('photo')).toBeInstanceOf(Blob);
    expect(body.get('caption')).toBeNull();
    expect(body.get('reply_markup')).toBeNull();
  });
});
