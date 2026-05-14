/**
 * Telegram media message handling.
 * Downloads and processes photo, document, audio, voice, video, and video_note messages.
 *
 * Bounded by `MediaLimits` since PR4 c5 (Codex P0.2):
 * - `perFileBytes` caps any single download; the pre-getFile check uses
 *   `msg.<media>.file_size` from the update payload to refuse oversized
 *   media without hitting Telegram at all. The downloadFile() call also
 *   enforces the cap on the Content-Length header and on the
 *   materialized buffer (defensive).
 * - `totalQuotaBytes` caps the cumulative bytes resident in `downloadDir`.
 *   Before each write, oldest-by-mtime files are evicted until the new
 *   write fits. LRU eviction is best-effort — sibling files placed by
 *   another writer count toward the same quota.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TelegramAPI } from './api.js';
import { transcribeVoice } from './transcribe.js';
import { TelegramMessage } from '../../types/index.js';
import { ensureDir } from '../../utils/atomic.js';

/**
 * Per-call bounds for the media-download pipeline. Both fields are
 * optional; absent means "no limit" — the constructor on TelegramConnector
 * is the canonical source of defaults (20 MB / 500 MB) and only forwards
 * undefined when a test explicitly opts out.
 */
export interface MediaLimits {
  perFileBytes?: number;
  totalQuotaBytes?: number;
}

/**
 * Sum file sizes of every regular file directly under `dir`. Best-effort —
 * unreadable entries are skipped. Used by enforceQuota() to decide whether
 * a new download fits within `totalQuotaBytes`.
 */
function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) total += stat.size;
      } catch { /* skip */ }
    }
  } catch { /* dir missing — zero */ }
  return total;
}

/**
 * Evict oldest-by-mtime files from `dir` until `incomingBytes` would fit
 * under `totalQuotaBytes`. Logs each eviction. Best-effort — failures to
 * unlink are silently skipped so a permission error doesn't abort the
 * download (the cap recheck downstream will catch the truly over-quota
 * case).
 */
function enforceQuota(dir: string, incomingBytes: number, totalQuotaBytes: number): void {
  if (incomingBytes >= totalQuotaBytes) {
    // Single file already exceeds total quota — the perFile cap should
    // have caught this; this branch is the defense-in-depth log line.
    return;
  }
  let used = dirSizeBytes(dir);
  if (used + incomingBytes <= totalQuotaBytes) return;
  // Sort files by mtime ascending; evict until we fit.
  type Entry = { path: string; size: number; mtime: number };
  let entries: Entry[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isFile()) entries.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  } catch { return; }
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (used + incomingBytes <= totalQuotaBytes) break;
    try {
      fs.unlinkSync(e.path);
      used -= e.size;
      console.error(`[telegram-media] quota evicted ${e.path} (${e.size} bytes)`);
    } catch { /* skip */ }
  }
}

export interface ProcessedMedia {
  type: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'video_note';
  chat_id: number;
  from: string;
  text: string;
  date: number;
  image_path?: string;
  file_path?: string;
  file_name?: string;
  duration?: number;
  transcript?: string;
}

/**
 * Sanitize a filename by stripping unsafe characters.
 * Keeps only a-zA-Z0-9._- and limits to 200 chars.
 * Returns "unnamed_file" if result is empty.
 */
export function sanitizeFilename(name: string | null | undefined): string {
  if (!name) return 'unnamed_file';
  // Strip directory components
  let sanitized = path.basename(name);
  // Keep only safe characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
  // Ensure non-empty
  if (!sanitized) return 'unnamed_file';
  // Limit length
  return sanitized.slice(0, 200);
}

/**
 * Format a Unix timestamp as YYYYMMDD_HHmmss.
 */
function formatDate(unixTs: number): string {
  const d = new Date(unixTs * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Refuse-if-too-large helper. Returns true when the declared file_size
 * exceeds the cap and the caller should bail without hitting Telegram.
 */
function rejectOversize(
  declaredSize: number | undefined,
  kind: ProcessedMedia['type'],
  perFileBytes: number | undefined,
): boolean {
  if (perFileBytes === undefined) return false;
  if (declaredSize === undefined) return false;
  if (declaredSize <= perFileBytes) return false;
  console.error(`[telegram-media] refusing ${kind}: declared ${declaredSize} bytes > cap ${perFileBytes}`);
  return true;
}

/**
 * Pre-write quota enforcement. Sums downloadDir, evicts oldest files
 * until incoming bytes fit. No-op when totalQuotaBytes is undefined.
 */
function maybeEnforceQuota(
  downloadDir: string,
  incomingBytes: number,
  totalQuotaBytes: number | undefined,
): void {
  if (totalQuotaBytes === undefined) return;
  enforceQuota(downloadDir, incomingBytes, totalQuotaBytes);
}

/**
 * Process a Telegram message for media content.
 * Downloads the file and returns a ProcessedMedia object, or null if no media.
 *
 * `limits.perFileBytes` rejects any single download exceeding the cap
 * (declared via `file_size` on the update OR observed via Content-Length
 * / buffer size — see TelegramAPI.downloadFile). On reject we return
 * `null` and the connector falls back to text-only delivery so the
 * agent still sees the caption.
 *
 * `limits.totalQuotaBytes` caps cumulative bytes in `downloadDir`. We
 * LRU-evict oldest files before each write until the new file fits.
 *
 * Both limits are documented in src/connectors/telegram/media.ts and
 * forwarded from TelegramConnector's constructor opts.mediaLimits.
 */
export async function processMediaMessage(
  msg: TelegramMessage,
  api: TelegramAPI,
  downloadDir: string,
  limits?: MediaLimits,
): Promise<ProcessedMedia | null> {
  const chatId = msg.chat.id;
  const from = msg.from?.first_name || 'Unknown';
  const date = msg.date || Math.floor(Date.now() / 1000);
  const caption = msg.caption || '';
  const perFile = limits?.perFileBytes;
  const totalQuota = limits?.totalQuotaBytes;

  ensureDir(downloadDir);

  // Photo: get largest (last element in array)
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    if (rejectOversize(largest.file_size, 'photo', perFile)) return null;
    const fileResponse = await api.getFile(largest.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    // Extract unique suffix: last 11 chars of file_path before extension
    const baseName = path.basename(filePath);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const suffix = nameWithoutExt.slice(-11);
    const dateStr = formatDate(date);
    const localFile = path.join(downloadDir, `${dateStr}_${suffix}.jpg`);

    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    return {
      type: 'photo',
      chat_id: chatId,
      from,
      text: caption,
      date,
      image_path: localFile,
    };
  }

  // PR4 c15 (Codex round-2 P1.F): prefix non-photo downloads with the
  // Telegram message_id so two media messages with the same provider
  // filename (`report.pdf` arrives twice in a chat) write to distinct
  // local paths. Pre-c15 the second arrival overwrote the first BEFORE
  // the agent finished reading it — silent content loss.
  // The prefix `msg<message_id>_` is short, sortable, and survives
  // `sanitizeFilename` (alphanumeric + `_`). The photo case already
  // had a unique-suffix derivation from Telegram's file_path; the doc /
  // audio / video / voice / video_note cases get this prefix.
  const collisionPrefix = `msg${msg.message_id}_`;

  // Document
  if (msg.document) {
    if (rejectOversize(msg.document.file_size, 'document', perFile)) return null;
    const fileName = `${collisionPrefix}${sanitizeFilename(msg.document.file_name)}`;
    const fileResponse = await api.getFile(msg.document.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    return {
      type: 'document',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
    };
  }

  // Audio
  if (msg.audio) {
    if (rejectOversize(msg.audio.file_size, 'audio', perFile)) return null;
    const defaultName = `audio_${date}.ogg`;
    const fileName = `${collisionPrefix}${msg.audio.file_name ? sanitizeFilename(msg.audio.file_name) : defaultName}`;
    const fileResponse = await api.getFile(msg.audio.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    return {
      type: 'audio',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.audio.duration,
    };
  }

  // Voice
  if (msg.voice) {
    if (rejectOversize(msg.voice.file_size, 'voice', perFile)) return null;
    const fileName = `${collisionPrefix}voice_${date}.ogg`;
    const fileResponse = await api.getFile(msg.voice.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    const transcript = await transcribeVoice(localFile);

    return {
      type: 'voice',
      chat_id: chatId,
      from,
      text: '',
      date,
      file_path: localFile,
      duration: msg.voice.duration,
      transcript: transcript || undefined,
    };
  }

  // Video
  if (msg.video) {
    if (rejectOversize(msg.video.file_size, 'video', perFile)) return null;
    const defaultName = `video_${date}.mp4`;
    const fileName = `${collisionPrefix}${msg.video.file_name ? sanitizeFilename(msg.video.file_name) : defaultName}`;
    const fileResponse = await api.getFile(msg.video.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    return {
      type: 'video',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.video.duration,
    };
  }

  // Video Note (round video)
  if (msg.video_note) {
    if (rejectOversize(msg.video_note.file_size, 'video_note', perFile)) return null;
    const fileName = `${collisionPrefix}videonote_${date}.mp4`;
    const fileResponse = await api.getFile(msg.video_note.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath, { maxBytes: perFile });
    maybeEnforceQuota(downloadDir, data.length, totalQuota);
    fs.writeFileSync(localFile, data);

    return {
      type: 'video_note',
      chat_id: chatId,
      from,
      text: '',
      date,
      file_path: localFile,
      duration: msg.video_note.duration,
    };
  }

  return null;
}
