/**
 * Voice transcription via local whisper.cpp (whisper-cli).
 *
 * Returns null on any failure (binary missing, model missing, timeout,
 * empty output). The caller treats null as "no transcript available" and
 * the agent still receives the .ogg path — agents capable of running
 * whisper themselves can do so.
 *
 * Disable entirely with CTX_TELEGRAM_NO_TRANSCRIBE=1.
 * Override binaries / model with CTX_WHISPER_BIN, CTX_FFMPEG_BIN,
 * CTX_WHISPER_MODEL.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 60_000;

function resolveModelPath(): string {
  if (process.env.CTX_WHISPER_MODEL) return process.env.CTX_WHISPER_MODEL;
  return path.join(os.homedir(), '.cortextos', 'models', 'ggml-tiny.en.bin');
}

function resolveBin(envVar: string, fallback: string): string {
  return process.env[envVar] || fallback;
}

export interface TranscribeOptions {
  timeoutMs?: number;
  modelPath?: string;
  log?: (line: string) => void;
}

/**
 * Transcribe a Telegram voice .ogg file. Returns the trimmed transcript
 * text, or null if transcription was unavailable / failed.
 */
export async function transcribeVoice(
  oggPath: string,
  opts: TranscribeOptions = {},
): Promise<string | null> {
  if (process.env.CTX_TELEGRAM_NO_TRANSCRIBE === '1') return null;
  if (!oggPath || !fs.existsSync(oggPath)) return null;

  const log = opts.log || (() => {});
  const modelPath = opts.modelPath || resolveModelPath();
  const ffmpegBin = resolveBin('CTX_FFMPEG_BIN', 'ffmpeg');
  const whisperBin = resolveBin('CTX_WHISPER_BIN', 'whisper-cli');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!fs.existsSync(modelPath)) {
    log(`[transcribe] model not found at ${modelPath} — skipping; run scripts/install-whisper-model.sh to enable transcription`);
    return null;
  }

  const wavPath = oggPath.replace(/\.ogg$/i, '.wav');
  const ffmpegOk = await runProcess(
    ffmpegBin,
    ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    timeoutMs,
  );
  if (!ffmpegOk.ok) {
    log(`[transcribe] ffmpeg failed (${ffmpegOk.reason}) — skipping`);
    return null;
  }

  try {
    const whisper = await runProcess(
      whisperBin,
      ['-m', modelPath, '-f', wavPath, '-nt', '-np'],
      timeoutMs,
      true,
    );
    if (!whisper.ok) {
      log(`[transcribe] whisper-cli failed (${whisper.reason}) — skipping`);
      return null;
    }
    const text = (whisper.stdout || '').trim();
    if (!text) {
      log('[transcribe] whisper-cli produced empty output — skipping');
      return null;
    }
    return text;
  } finally {
    if (fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore cleanup error */ }
    }
  }
}

interface ProcessResult {
  ok: boolean;
  reason?: string;
  stdout?: string;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
  capture = false,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const settle = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn(bin, args, {
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch (err) {
      return settle({ ok: false, reason: `spawn-error: ${(err as Error).message}` });
    }

    if (capture && proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    }
    proc.on('error', (err) => settle({ ok: false, reason: `error: ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0) return settle({ ok: true, stdout });
      settle({ ok: false, reason: `exit-${code}`, stdout });
    });
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}
