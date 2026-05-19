import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import {
  synthesizeVoice,
  isKnownOpenAITtsVoice,
  validateVoiceModelCompatibility,
  OPENAI_TTS_VOICES,
  OPENAI_TTS_VOICES_TTS1,
  OPENAI_TTS_VOICES_GPT4O,
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

describe('voice/model constants', () => {
  it('OPENAI_TTS_VOICES_TTS1 contains the 9 verified tts-1 voices', () => {
    expect(OPENAI_TTS_VOICES_TTS1).toEqual([
      'alloy', 'ash', 'coral', 'echo', 'fable',
      'nova', 'onyx', 'sage', 'shimmer',
    ]);
  });

  it('OPENAI_TTS_VOICES_GPT4O contains the gpt-4o-only voices', () => {
    expect(OPENAI_TTS_VOICES_GPT4O).toContain('cedar');
    expect(OPENAI_TTS_VOICES_GPT4O).toContain('ballad');
    expect(OPENAI_TTS_VOICES_GPT4O).toContain('marin');
    expect(OPENAI_TTS_VOICES_GPT4O).toContain('verse');
  });

  it('tts-1 and gpt-4o voice sets are disjoint', () => {
    const tts1 = new Set(OPENAI_TTS_VOICES_TTS1);
    for (const v of OPENAI_TTS_VOICES_GPT4O) {
      expect(tts1.has(v)).toBe(false);
    }
  });
});

describe('validateVoiceModelCompatibility', () => {
  it('approves any tts-1 voice on tts-1', () => {
    for (const v of OPENAI_TTS_VOICES_TTS1) {
      expect(validateVoiceModelCompatibility(v, 'tts-1').ok).toBe(true);
    }
  });

  it('approves any tts-1 voice on tts-1-hd', () => {
    for (const v of OPENAI_TTS_VOICES_TTS1) {
      expect(validateVoiceModelCompatibility(v, 'tts-1-hd').ok).toBe(true);
    }
  });

  it('rejects a gpt-4o-only voice on tts-1 with a clear hint', () => {
    const result = validateVoiceModelCompatibility('cedar', 'tts-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cedar/);
      expect(result.reason).toMatch(/gpt-4o-mini-tts/);
      expect(result.reason).toMatch(/tts-1/);
    }
  });

  it('rejects a gpt-4o-only voice on tts-1-hd with the same hint', () => {
    const result = validateVoiceModelCompatibility('cedar', 'tts-1-hd');
    expect(result.ok).toBe(false);
  });

  it('approves a gpt-4o-only voice on gpt-4o-mini-tts', () => {
    expect(validateVoiceModelCompatibility('cedar', 'gpt-4o-mini-tts').ok).toBe(true);
    expect(validateVoiceModelCompatibility('marin', 'gpt-4o-mini-tts').ok).toBe(true);
  });

  it('approves a tts-1 voice on gpt-4o-mini-tts (the newer model accepts the legacy set)', () => {
    expect(validateVoiceModelCompatibility('alloy', 'gpt-4o-mini-tts').ok).toBe(true);
  });

  it('approves unknown voices on any model (forward-compat)', () => {
    expect(validateVoiceModelCompatibility('futurevoice', 'tts-1').ok).toBe(true);
    expect(validateVoiceModelCompatibility('futurevoice', 'gpt-4o-mini-tts').ok).toBe(true);
  });

  it('is case-insensitive on voice and model strings', () => {
    expect(validateVoiceModelCompatibility('CEDAR', 'TTS-1').ok).toBe(false);
    expect(validateVoiceModelCompatibility('Alloy', 'TTS-1').ok).toBe(true);
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

  it('rejects gpt-4o-only voice on tts-1 with the local hint (no API round-trip)', async () => {
    // fetch should NOT be called - the pre-flight catches this before
    // any HTTP traffic.
    globalThis.fetch = vi.fn(() => {
      throw new Error('fetch should not be called when validation rejects');
    }) as any;

    await expect(
      synthesizeVoice('hi', 'cedar', { apiKey: 'k', model: 'tts-1' }),
    ).rejects.toThrow(/cedar/);
    await expect(
      synthesizeVoice('hi', 'cedar', { apiKey: 'k', model: 'tts-1' }),
    ).rejects.toThrow(/gpt-4o-mini-tts/);
  });

  it('allows gpt-4o-only voice on gpt-4o-mini-tts model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from([0x4f, 0x67, 0x67]), { status: 200 }),
    ) as any;

    const buf = await synthesizeVoice('hi', 'cedar', {
      apiKey: 'k',
      model: 'gpt-4o-mini-tts',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('rejects out-of-range speed before the API round-trip', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('fetch should not be called when speed is invalid');
    }) as any;

    await expect(
      synthesizeVoice('hi', 'alloy', { apiKey: 'k', speed: 0.1 }),
    ).rejects.toThrow(/speed 0\.1 is out of range/);
    await expect(
      synthesizeVoice('hi', 'alloy', { apiKey: 'k', speed: 5.0 }),
    ).rejects.toThrow(/speed 5 is out of range/);
    await expect(
      synthesizeVoice('hi', 'alloy', { apiKey: 'k', speed: 4.5 }),
    ).rejects.toThrow(/0\.25-4\.0/);
  });

  it('accepts speed at boundaries 0.25 and 4.0', async () => {
    let captured: { body: any } | null = null;
    globalThis.fetch = vi.fn(async (_input: any, init?: any) => {
      captured = { body: JSON.parse(String(init?.body)) };
      return new Response(Buffer.from([0]), { status: 200 });
    }) as any;

    await synthesizeVoice('hi', 'alloy', { apiKey: 'k', speed: 0.25 });
    expect(captured!.body.speed).toBe(0.25);
    await synthesizeVoice('hi', 'alloy', { apiKey: 'k', speed: 4.0 });
    expect(captured!.body.speed).toBe(4.0);
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

    await synthesizeVoice('hello world', 'Alloy', { apiKey: 'k' });

    expect(captured!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(captured!.body.model).toBe('tts-1');
    expect(captured!.body.voice).toBe('alloy'); // lowercased before send
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
