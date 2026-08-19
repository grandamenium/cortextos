// Local voice transcription for the Crew chat — whisper.cpp via whisper-cli.
//
// Dashboard-side port of src/telegram/transcribe.ts (the projects have
// separate build boundaries, same as messages/send re-implements
// send-message.sh). One deliberate difference: the model is auto-selected
// from what's installed in ~/.cortextos/models, preferring accuracy —
// base.en over tiny.en — because chat dictation is short and an M-series
// mini transcribes a voice note with base.en in a couple of seconds.
//
// Returns null on any failure; the caller falls back to delivering the
// audio path without a transcript. Same env overrides as the daemon:
// CTX_WHISPER_BIN, CTX_FFMPEG_BIN, CTX_WHISPER_MODEL, CTX_WHISPER_LANG.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_TIMEOUT_MS = 60_000;
const MODEL_PREFERENCE = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-tiny.en.bin'];

function resolveModelPath(): string | null {
  if (process.env.CTX_WHISPER_MODEL) return process.env.CTX_WHISPER_MODEL;
  const dir = path.join(os.homedir(), '.cortextos', 'models');
  for (const name of MODEL_PREFERENCE) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
      proc = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    } catch (err) {
      return settle({ ok: false, reason: `spawn-error: ${(err as Error).message}` });
    }

    if (capture && proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }
    proc.on('error', (err) => settle({ ok: false, reason: `error: ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0) return settle({ ok: true, stdout });
      settle({ ok: false, reason: `exit-${code}`, stdout });
    });
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}

/**
 * Transcribe any ffmpeg-readable audio file (webm/opus from Chrome,
 * m4a from iOS Safari, ogg from Telegram). Returns trimmed text or null.
 */
export async function transcribeAudio(inputPath: string): Promise<string | null> {
  if (!inputPath || !fs.existsSync(inputPath)) return null;

  const modelPath = resolveModelPath();
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.warn('[transcribe] no whisper model in ~/.cortextos/models — run scripts/install-whisper-model.sh');
    return null;
  }

  const ffmpegBin = process.env.CTX_FFMPEG_BIN || 'ffmpeg';
  const whisperBin = process.env.CTX_WHISPER_BIN || 'whisper-cli';
  const lang = process.env.CTX_WHISPER_LANG || 'auto';

  const wavPath = `${inputPath}.wav`;
  const ffmpegOk = await runProcess(
    ffmpegBin,
    ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    DEFAULT_TIMEOUT_MS,
  );
  if (!ffmpegOk.ok) {
    console.warn(`[transcribe] ffmpeg failed (${ffmpegOk.reason})`);
    return null;
  }

  try {
    const whisper = await runProcess(
      whisperBin,
      ['-m', modelPath, '-f', wavPath, '-l', lang, '-nt', '-np'],
      DEFAULT_TIMEOUT_MS,
      true,
    );
    if (!whisper.ok) {
      console.warn(`[transcribe] whisper-cli failed (${whisper.reason})`);
      return null;
    }
    const text = (whisper.stdout || '').trim();
    return text || null;
  } finally {
    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch {
      /* ignore cleanup error */
    }
  }
}
