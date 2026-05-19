import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import {
  synthesizeVoice,
  isKnownOpenAITtsVoice,
  OPENAI_TTS_VOICES,
} from '../../../src/telegram/tts';

describe('isKnownOpenAITtsVoice', () => {
  it('returns true for every voice in OPENAI_TTS_VOICES', () => {
    for (const v of OPENAI_TTS_VOICES) {
      expect(isKnownOpenAITtsVoice(v)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isKnownOpenAITtsVoice('CEDAR')).toBe(true);
    expect(isKnownOpenAITtsVoice('Alloy')).toBe(true);
    expect(isKnownOpenAITtsVoice('sAgE')).toBe(true);
  });

  it('returns false for unknown values', () => {
    expect(isKnownOpenAITtsVoice('daniel')).toBe(false);
    expect(isKnownOpenAITtsVoice('antoni')).toBe(false);
    expect(isKnownOpenAITtsVoice('')).toBe(false);
    expect(isKnownOpenAITtsVoice('somename')).toBe(false);
  });
});

describe('synthesizeVoice', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('throws when text is empty', async () => {
    await expect(synthesizeVoice('', 'alloy', { apiKey: 'k' })).rejects.toThrow(/text is empty/);
    await expect(synthesizeVoice('   ', 'alloy', { apiKey: 'k' })).rejects.toThrow(/text is empty/);
  });

  it('throws when voice is empty', async () => {
    await expect(synthesizeVoice('hi', '', { apiKey: 'k' })).rejects.toThrow(/voice is empty/);
    await expect(synthesizeVoice('hi', '   ', { apiKey: 'k' })).rejects.toThrow(/voice is empty/);
  });

  it('throws a helpful error when no API key is in env and none passed', async () => {
    await expect(synthesizeVoice('hi', 'alloy')).rejects.toThrow(/no OpenAI API key/);
  });

  it('uses OPENAI_API_KEY from env when no override is passed', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'audio/ogg' },
      });
    }) as any;

    const buf = await synthesizeVoice('hello', 'alloy');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(capturedHeaders!.get('authorization')).toBe('Bearer env-key');
  });

  it('POSTs to /audio/speech with the expected body shape', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response(Buffer.from([0x4f, 0x67, 0x67]), { status: 200 });
    }) as any;

    await synthesizeVoice('hello world', 'Cedar', { apiKey: 'k' });

    expect(captured!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(captured!.body.model).toBe('tts-1');
    expect(captured!.body.voice).toBe('cedar'); // lowercased before send
    expect(captured!.body.input).toBe('hello world');
    expect(captured!.body.response_format).toBe('opus');
    expect(captured!.body.speed).toBe(1.0);
  });

  it('passes through model and speed overrides', async () => {
    let captured: { body: any } | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      captured = { body: JSON.parse(String(init?.body)) };
      return new Response(Buffer.from([0]), { status: 200 });
    }) as any;

    await synthesizeVoice('hi', 'alloy', {
      apiKey: 'k',
      model: 'tts-1-hd',
      speed: 1.25,
    });

    expect(captured!.body.model).toBe('tts-1-hd');
    expect(captured!.body.speed).toBe(1.25);
  });

  it('accepts unknown voice names (OpenAI may add new ones)', async () => {
    let captured: { body: any } | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      captured = { body: JSON.parse(String(init?.body)) };
      return new Response(Buffer.from([0]), { status: 200 });
    }) as any;

    // Not in OPENAI_TTS_VOICES yet, but still passed through.
    await synthesizeVoice('hi', 'futurevoice', { apiKey: 'k' });
    expect(captured!.body.voice).toBe('futurevoice');
  });

  it('surfaces OpenAI JSON error body via error.message', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid voice: 'xxx'. Supported voices are: 'alloy', 'ash', ...",
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as any;

    await expect(
      synthesizeVoice('hi', 'xxx', { apiKey: 'k' }),
    ).rejects.toThrow(/OpenAI error: Invalid voice/);
  });

  it('falls back to raw body when OpenAI returns non-JSON error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('upstream cloudflare error', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    ) as any;

    await expect(
      synthesizeVoice('hi', 'alloy', { apiKey: 'k' }),
    ).rejects.toThrow(/OpenAI error: upstream cloudflare error/);
  });

  it('surfaces a clear timeout error when the request aborts', async () => {
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

    await expect(
      synthesizeVoice('hi', 'alloy', { apiKey: 'k', timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after/);
  }, 5000);

  it('honors a custom baseUrl (test injection)', async () => {
    let captured: { url: string } | null = null;
    globalThis.fetch = vi.fn(async (input: any) => {
      captured = { url: String(input) };
      return new Response(Buffer.from([0]), { status: 200 });
    }) as any;

    await synthesizeVoice('hi', 'alloy', {
      apiKey: 'k',
      baseUrl: 'http://localhost:9999/mock',
    });

    expect(captured!.url).toBe('http://localhost:9999/mock/audio/speech');
  });
});
