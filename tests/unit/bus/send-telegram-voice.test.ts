import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { sendTelegramVoice } from '../../../src/bus/send-telegram-voice';

const mockSpawnSync = spawnSync as unknown as Mock;

describe('sendTelegramVoice', () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockSpawnSync.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  });

  it('returns a clear error when OPENAI_API_KEY is missing', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toEqual({ ok: false, error: 'OPENAI_API_KEY not set' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns a clear error when TELEGRAM_BOT_TOKEN is missing', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toEqual({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('synthesizes with OpenAI, converts to OGG Opus, and posts sendVoice to Telegram', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 987 } }),
      } as Response);

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      const outputPath = args[args.length - 1];
      writeFileSync(outputPath, Buffer.from([7, 8, 9]));
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await sendTelegramVoice('chat-123', 'Speak this');

    expect(result).toEqual({ ok: true, messageId: 987 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [openAiUrl, openAiInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(openAiUrl).toBe('https://api.openai.com/v1/audio/speech');
    expect(openAiInit.method).toBe('POST');
    expect((openAiInit.headers as Record<string, string>).Authorization).toBe('Bearer openai-token');
    expect(JSON.parse(String(openAiInit.body))).toEqual({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Speak this',
      response_format: 'mp3',
    });

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [ffmpegCmd, ffmpegArgs] = mockSpawnSync.mock.calls[0] as [string, string[]];
    expect(ffmpegCmd).toBe('ffmpeg');
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on']));
    expect(ffmpegArgs[ffmpegArgs.length - 1]).toMatch(/voice\.ogg$/);

    const [telegramUrl, telegramInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(telegramUrl).toBe('https://api.telegram.org/bottelegram-token/sendVoice');
    expect(telegramInit.method).toBe('POST');
    expect(telegramInit.body).toBeInstanceOf(FormData);
    const formData = telegramInit.body as FormData;
    expect(formData.get('chat_id')).toBe('chat-123');
    expect(formData.get('voice')).toBeInstanceOf(Blob);
  });
});
