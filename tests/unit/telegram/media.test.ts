import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sanitizeFilename, processMediaMessage } from '../../../src/telegram/media';
import type { TelegramMessage } from '../../../src/types';

// Mock TelegramAPI
function createMockApi(filePath: string = 'photos/file_123.jpg', fileData: Buffer = Buffer.from('test-data')) {
  return {
    getFile: vi.fn().mockResolvedValue({ result: { file_path: filePath } }),
    downloadFile: vi.fn().mockResolvedValue(fileData),
  } as any;
}

describe('sanitizeFilename', () => {
  it('keeps safe characters', () => {
    expect(sanitizeFilename('hello_world-2.txt')).toBe('hello_world-2.txt');
  });

  it('strips unsafe characters', () => {
    expect(sanitizeFilename('hello world!@#$.txt')).toBe('helloworld.txt');
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('unnamed_file');
  });

  it('handles null', () => {
    expect(sanitizeFilename(null)).toBe('unnamed_file');
  });

  it('handles undefined', () => {
    expect(sanitizeFilename(undefined)).toBe('unnamed_file');
  });

  it('handles all-unsafe characters', () => {
    expect(sanitizeFilename('!!!@@@###')).toBe('unnamed_file');
  });

  it('limits length to 200 chars', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('strips directory components', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
  });

  it('handles unicode characters', () => {
    expect(sanitizeFilename('файл.txt')).toBe('.txt');
  });
});

describe('processMediaMessage', () => {
  let downloadDir: string;
  let prevNoTranscribe: string | undefined;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'cortextos-media-test-'));
    // Disable transcription in unit tests to avoid spawning whisper-cli on
    // junk audio bytes. transcribe.ts has dedicated tests.
    prevNoTranscribe = process.env.CTX_TELEGRAM_NO_TRANSCRIBE;
    process.env.CTX_TELEGRAM_NO_TRANSCRIBE = '1';
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
    if (prevNoTranscribe === undefined) {
      delete process.env.CTX_TELEGRAM_NO_TRANSCRIBE;
    } else {
      process.env.CTX_TELEGRAM_NO_TRANSCRIBE = prevNoTranscribe;
    }
  });

  function makeMsg(overrides: Partial<TelegramMessage>): TelegramMessage {
    return {
      message_id: 1,
      date: 1700000000,
      chat: { id: 42, type: 'private' },
      from: { id: 1, first_name: 'Alice' },
      ...overrides,
    };
  }

  it('returns null for messages without media', async () => {
    const msg = makeMsg({ text: 'hello' });
    const api = createMockApi();
    const result = await processMediaMessage(msg, api, downloadDir);
    expect(result).toBeNull();
  });

  it('processes photo messages', async () => {
    const msg = makeMsg({
      photo: [
        { file_id: 'small', width: 100, height: 100 },
        { file_id: 'large', width: 800, height: 600 },
      ],
      caption: 'nice pic',
    });
    const api = createMockApi('photos/file_ABCDEFGhijk.jpg');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('photo');
    expect(result!.chat_id).toBe(42);
    expect(result!.from).toBe('Alice');
    expect(result!.text).toBe('nice pic');
    expect(result!.image_path).toBeDefined();
    expect(result!.image_path!.endsWith('.jpg')).toBe(true);
    // Verify the largest photo was used
    expect(api.getFile).toHaveBeenCalledWith('large');
    // Verify file was written
    expect(existsSync(result!.image_path!)).toBe(true);
    expect(readFileSync(result!.image_path!).toString()).toBe('test-data');
  });

  it('processes document messages', async () => {
    const msg = makeMsg({
      document: { file_id: 'doc1', file_name: 'report.pdf' },
      caption: 'my report',
    });
    const api = createMockApi('documents/file_123.pdf');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('document');
    expect(result!.file_name).toBe('report.pdf');
    expect(result!.text).toBe('my report');
    expect(existsSync(result!.file_path!)).toBe(true);
  });

  it('processes document with unsafe filename', async () => {
    const msg = makeMsg({
      document: { file_id: 'doc1', file_name: '../../../etc/passwd' },
    });
    const api = createMockApi('documents/file_123.dat');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.file_name).toBe('passwd');
  });

  it('processes audio messages with filename', async () => {
    const msg = makeMsg({
      audio: { file_id: 'audio1', duration: 120, file_name: 'song.mp3' },
      caption: 'listen',
    });
    const api = createMockApi('audio/file_123.mp3');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('audio');
    expect(result!.file_name).toBe('song.mp3');
    expect(result!.duration).toBe(120);
    expect(existsSync(result!.file_path!)).toBe(true);
  });

  it('processes audio messages without filename (uses default)', async () => {
    const msg = makeMsg({
      audio: { file_id: 'audio1', duration: 60 },
    });
    const api = createMockApi('audio/file_123.ogg');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.file_name).toMatch(/^audio_\d+\.ogg$/);
  });

  it('processes voice messages', async () => {
    const msg = makeMsg({
      voice: { file_id: 'voice1', duration: 5 },
    });
    const api = createMockApi('voice/file_123.ogg');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('voice');
    expect(result!.text).toBe('');
    expect(result!.duration).toBe(5);
    expect(result!.file_path).toMatch(/voice_\d+\.ogg$/);
    expect(existsSync(result!.file_path!)).toBe(true);
  });

  it('voice message has undefined transcript when transcription disabled', async () => {
    const msg = makeMsg({
      voice: { file_id: 'voice1', duration: 5 },
    });
    const api = createMockApi('voice/file_123.ogg');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.transcript).toBeUndefined();
  });

  it('processes video messages with filename', async () => {
    const msg = makeMsg({
      video: { file_id: 'vid1', duration: 30, file_name: 'clip.mp4' },
      caption: 'watch this',
    });
    const api = createMockApi('video/file_123.mp4');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('video');
    expect(result!.file_name).toBe('clip.mp4');
    expect(result!.duration).toBe(30);
    expect(result!.text).toBe('watch this');
  });

  it('processes video messages without filename (uses default)', async () => {
    const msg = makeMsg({
      video: { file_id: 'vid1', duration: 30 },
    });
    const api = createMockApi('video/file_123.mp4');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.file_name).toMatch(/^video_\d+\.mp4$/);
  });

  it('processes video_note messages', async () => {
    const msg = makeMsg({
      video_note: { file_id: 'vnote1', duration: 10 },
    });
    const api = createMockApi('video_notes/file_123.mp4');
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('video_note');
    expect(result!.text).toBe('');
    expect(result!.duration).toBe(10);
    expect(result!.file_path).toMatch(/videonote_\d+\.mp4$/);
    expect(existsSync(result!.file_path!)).toBe(true);
  });

  it('returns null when getFile returns no file_path', async () => {
    const msg = makeMsg({
      photo: [{ file_id: 'bad', width: 100, height: 100 }],
    });
    const api = {
      getFile: vi.fn().mockResolvedValue({ result: {} }),
      downloadFile: vi.fn(),
    } as any;
    const result = await processMediaMessage(msg, api, downloadDir);
    expect(result).toBeNull();
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it('creates download directory if it does not exist', async () => {
    const nestedDir = join(downloadDir, 'sub', 'dir');
    const msg = makeMsg({
      voice: { file_id: 'v1', duration: 3 },
    });
    const api = createMockApi('voice/file.ogg');
    const result = await processMediaMessage(msg, api, nestedDir);

    expect(result).not.toBeNull();
    expect(existsSync(nestedDir)).toBe(true);
  });
});
