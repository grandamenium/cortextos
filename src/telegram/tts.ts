/**
 * OpenAI text-to-speech client.
 *
 * Component 2 of voice-conversation-spec.md. Synthesizes a short text
 * (≈30s spoken, 60-80 words is the spec target) into an OGG/Opus audio
 * buffer that Telegram sendVoice will accept directly - no transcode step
 * needed.
 *
 * Uses built-in fetch only (no new runtime dependencies, matches the
 * cortextos contributor rule).
 *
 * The runtime needs an OPENAI_API_KEY in env. The org secrets.env already
 * carries it for other cortextos services (Codex, captions, etc), so the
 * voice-reply pipeline activates without any new credential plumbing once
 * the agent's voice is configured.
 */
import { Buffer } from 'buffer';

/**
 * OpenAI TTS voice names recognized by /v1/audio/speech.
 *
 * Per the voice-conversation-spec update 2026-05-19:
 *   - cedar is Zach's preferred default
 *   - alloy / fable / onyx / sage are the leading candidates for the
 *     Atlas / Sage agent voice distinction
 *
 * Kept as a frozen list rather than a Record so callers can iterate when
 * generating sample audio for the ear-pick step.
 */
/**
 * Voices supported by the legacy tts-1 / tts-1-hd models. The API rejects
 * everything else for these models with an explicit "Input should be ..."
 * error. Verified against OpenAI 2026-05-19 by Forge during the voice-
 * conversation-build samples generation.
 */
export const OPENAI_TTS_VOICES_TTS1 = Object.freeze([
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const);

/**
 * Voices that ONLY work on the gpt-4o-mini-tts model. tts-1 rejects these
 * even though they appear in OpenAI's broader voice library. Verified
 * 2026-05-19 (cedar tested live; ballad/marin/verse listed in OpenAI
 * docs but not tested directly here - if API rejects, update this list).
 */
export const OPENAI_TTS_VOICES_GPT4O = Object.freeze([
  'ballad',
  'cedar',
  'marin',
  'verse',
] as const);

/**
 * Union of every known OpenAI TTS voice. Kept as a frozen list for callers
 * that just want to iterate (sample generator). Use the model-specific
 * lists above when validating a (voice, model) pair.
 */
export const OPENAI_TTS_VOICES = Object.freeze([
  ...OPENAI_TTS_VOICES_TTS1,
  ...OPENAI_TTS_VOICES_GPT4O,
] as const);

export type OpenAITtsVoice = (typeof OPENAI_TTS_VOICES)[number];

/**
 * Loose validity check on a voice name. Returns true when the input is
 * one of the known OpenAI voices (case-insensitive). Returns false when
 * the input is not in the known list. The TTS client itself does not
 * reject unknown values - OpenAI may add new voices and we want callers
 * to be able to use them without waiting for a cortextos release - so
 * this helper is purely advisory.
 */
export function isKnownOpenAITtsVoice(value: string): boolean {
  return (OPENAI_TTS_VOICES as readonly string[]).includes(value.toLowerCase());
}

/**
 * Result of validateVoiceModelCompatibility - never throws on its own.
 * Callers decide whether to throw (synthesizeVoice does, to catch the
 * mismatch BEFORE the OpenAI round-trip) or just warn.
 */
export type VoiceModelCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a (voice, model) pair against the known model-specific voice
 * lists. Returns ok=true for unknown voices (OpenAI may add new ones
 * before this code knows about them) and for tts-1 voices on any model.
 * Returns ok=false with a clear hint when a known-gpt-4o-only voice is
 * paired with tts-1 (or vice versa, though that path is currently empty).
 */
export function validateVoiceModelCompatibility(
  voice: string,
  model: string,
): VoiceModelCheck {
  const v = voice.trim().toLowerCase();
  const m = model.trim().toLowerCase();

  const isTts1Voice = (OPENAI_TTS_VOICES_TTS1 as readonly string[]).includes(v);
  const isGpt4oVoice = (OPENAI_TTS_VOICES_GPT4O as readonly string[]).includes(v);

  // gpt-4o-only voice on tts-1 / tts-1-hd
  if (isGpt4oVoice && (m === 'tts-1' || m === 'tts-1-hd')) {
    return {
      ok: false,
      reason: `voice "${v}" is not supported on model "${m}". Set voice_model to "gpt-4o-mini-tts" in agent config.json, or pick a tts-1 voice (${OPENAI_TTS_VOICES_TTS1.join(', ')}).`,
    };
  }

  // tts-1 voice on gpt-4o is fine (gpt-4o-mini-tts accepts the tts-1 set
  // plus the extra voices). Unknown voices pass through.
  if (isTts1Voice || isGpt4oVoice || !isKnownOpenAITtsVoice(v)) {
    return { ok: true };
  }

  return { ok: true };
}

export interface SynthesizeOptions {
  /** Override the API key resolution. Default: process.env.OPENAI_API_KEY. */
  apiKey?: string;
  /** OpenAI TTS model. Default: tts-1 (fast + cheap). Use tts-1-hd for higher quality. */
  model?: 'tts-1' | 'tts-1-hd' | string;
  /** Playback speed, 0.25-4.0. Default: 1.0. */
  speed?: number;
  /** Request timeout in ms. Default: 60_000. */
  timeoutMs?: number;
  /** Override the base URL (test injection). */
  baseUrl?: string;
}

/**
 * Synthesize text into an OGG/Opus audio buffer via OpenAI TTS.
 *
 * The returned bytes are wrapped in an OGG container ready for Telegram
 * sendVoice - no ffmpeg transcode step. Telegram's voice player handles
 * the OGG/Opus encoding natively.
 *
 * @param text  Text to synthesize. Spec target is ≈60-80 words for a 30s
 *              spoken summary. OpenAI accepts up to 4096 chars per call.
 * @param voice One of OPENAI_TTS_VOICES, e.g. "alloy", "cedar". Case is
 *              normalized to lowercase before sending.
 * @returns OGG/Opus audio bytes. Caller writes to a temp file then
 *          passes the path to TelegramAPI.sendVoice. The CLI wiring in
 *          src/cli/bus.ts handles the temp-file lifecycle.
 */
export async function synthesizeVoice(
  text: string,
  voice: string,
  opts: SynthesizeOptions = {},
): Promise<Buffer> {
  if (!text || !text.trim()) {
    throw new Error('synthesizeVoice: text is empty');
  }
  if (!voice || !voice.trim()) {
    throw new Error('synthesizeVoice: voice is empty');
  }

  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    throw new Error(
      'synthesizeVoice: no OpenAI API key. Set OPENAI_API_KEY in the agent .env (or org secrets.env) or pass apiKey via SynthesizeOptions. The org secrets.env should already carry it for other cortextos services.',
    );
  }

  const model = opts.model ?? 'tts-1';
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const speed = opts.speed ?? 1.0;

  // Pre-flight (voice, model) check - catches the gpt-4o-mini-tts-only
  // voices (cedar/marin/etc) on tts-1 before the OpenAI round-trip, with
  // a clearer error than the API's enum-rejection.
  const compat = validateVoiceModelCompatibility(voice, model);
  if (!compat.ok) {
    throw new Error(`synthesizeVoice: ${compat.reason}`);
  }

  // Speed must be in OpenAI's accepted range. Out-of-range values get
  // rejected by the API; we surface the error locally with the explicit
  // range so callers do not have to dig through the API docs.
  if (speed < 0.25 || speed > 4.0) {
    throw new Error(
      `synthesizeVoice: speed ${speed} is out of range. OpenAI accepts 0.25-4.0.`,
    );
  }

  const body = {
    model,
    voice: voice.trim().toLowerCase(),
    input: text,
    response_format: 'opus',
    speed,
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(
        `synthesizeVoice: OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    throw new Error(`synthesizeVoice: fetch failed: ${err}`);
  }

  if (!response.ok) {
    // OpenAI error bodies are JSON: { error: { message, type, code } }.
    // Pull error.message for a useful detail; fall back to status text.
    let detail = `HTTP ${response.status}`;
    try {
      const errText = await response.text();
      if (errText) {
        try {
          const parsed = JSON.parse(errText);
          detail = parsed?.error?.message ?? errText.slice(0, 200);
        } catch {
          detail = errText.slice(0, 200);
        }
      }
    } catch {
      // body read failed; keep status-based detail
    }
    throw new Error(`synthesizeVoice: OpenAI error: ${detail}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
