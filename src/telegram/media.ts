/**
 * Telegram media message handling.
 * Downloads and processes photo, document, audio, voice, video, and video_note messages.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TelegramAPI } from './api.js';
import { transcribeVoice } from './transcribe.js';
import { TelegramMessage } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';

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
 * Process a Telegram message for media content.
 * Downloads the file and returns a ProcessedMedia object, or null if no media.
 */
export async function processMediaMessage(
  msg: TelegramMessage,
  api: TelegramAPI,
  downloadDir: string,
): Promise<ProcessedMedia | null> {
  const chatId = msg.chat.id;
  const from = msg.from?.first_name || 'Unknown';
  const date = msg.date || Math.floor(Date.now() / 1000);
  const caption = msg.caption || '';

  ensureDir(downloadDir);

  // Photo: get largest (last element in array)
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const fileResponse = await api.getFile(largest.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    // Extract unique suffix: last 11 chars of file_path before extension
    const baseName = path.basename(filePath);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const suffix = nameWithoutExt.slice(-11);
    const dateStr = formatDate(date);
    const localFile = path.join(downloadDir, `${dateStr}_${suffix}.jpg`);

    const data = await api.downloadFile(filePath);
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

  // Document
  if (msg.document) {
    const fileName = sanitizeFilename(msg.document.file_name);
    const fileResponse = await api.getFile(msg.document.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
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
    const defaultName = `audio_${date}.ogg`;
    const fileName = msg.audio.file_name
      ? sanitizeFilename(msg.audio.file_name)
      : defaultName;
    const fileResponse = await api.getFile(msg.audio.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
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
    const fileName = `voice_${date}.ogg`;
    const fileResponse = await api.getFile(msg.voice.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
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
    const defaultName = `video_${date}.mp4`;
    const fileName = msg.video.file_name
      ? sanitizeFilename(msg.video.file_name)
      : defaultName;
    const fileResponse = await api.getFile(msg.video.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
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
    const fileName = `videonote_${date}.mp4`;
    const fileResponse = await api.getFile(msg.video_note.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
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
