/**
 * Voice transcription via the local Moshi daemon at 127.0.0.1:8093.
 *
 * Used by the fast-checker voice path to attach a transcript: line to
 * the inbox payload alongside the local_file: path. Failures (daemon
 * down, timeout, bad audio) return "" — caller falls back to path-only.
 */

const DAEMON_URL = 'http://127.0.0.1:8093';
const MIN_TIMEOUT_MS = 5000;
const TIMEOUT_PER_SECOND_MS = 400; // Moshi observed at ~0.27x realtime; 0.4x is conservative

interface TranscribeResponse {
  transcript: string;
  word_count?: number;
  duration_s?: number;
  elapsed_s?: number;
}

/**
 * Transcribe a voice file via the local daemon. Returns "" on any failure.
 * @param absPath absolute path to the .ogg (Telegram voice download)
 * @param durationS audio duration in seconds (from Telegram metadata) — used to
 *   scale the timeout (max(5s, duration * 0.4)). Telegram caps voice at 60s,
 *   so the worst-case timeout is ~24s.
 */
export async function transcribeVoice(absPath: string, durationS?: number): Promise<string> {
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, (durationS ?? 0) * TIMEOUT_PER_SECOND_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${DAEMON_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absPath }),
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = (await res.json()) as TranscribeResponse;
    return (data.transcript || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
