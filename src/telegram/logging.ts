/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import type { BusPaths, TelegramMessage, TelegramUpdate } from '../types/index.js';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: object,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  logInboundMessage(ctxRoot, agentName, {
    message_id: msg.message_id,
    from: msg.from?.id,
    from_name: fromName,
    chat_id: msg.chat?.id,
    text,
    timestamp: new Date().toISOString(),
  });

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }
}

/**
 * Archive an inbound Telegram message that the cortextos-side mention-only
 * filter chose NOT to forward to the agent session. Same JSONL shape as
 * `inbound-messages.jsonl` plus a `filter_reason` discriminant so post-hoc
 * diagnostics know WHY the message was dropped.
 *
 * Path: `{ctxRoot}/logs/{agentName}/filtered-inbound.jsonl`
 *
 * Single source of truth for "messages we received from Telegram but did
 * not act on" — useful when debugging "why didn't the bot respond to X"
 * after a privacy-mode quirk or service-message storm. See
 * BL-2026-05-10-001 § Required new primitives.
 *
 * Write failures are silently swallowed: the call site lives inside
 * the Phase 2 poller.onMessage callback where an unhandled throw would
 * stall the poll loop. Diagnostics are best-effort and must never
 * break message processing — same contract as recordRawTelegramUpdate.
 */
export function recordFilteredInbound(
  ctxRoot: string,
  agentName: string,
  msg: TelegramMessage,
  filterReason: string,
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });

    const entry = JSON.stringify({
      message_id: msg.message_id,
      from: msg.from?.id,
      from_name: msg.from?.first_name ?? msg.from?.username,
      chat_id: msg.chat?.id,
      chat_type: msg.chat?.type,
      text: msg.text ?? msg.caption ?? '',
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent: agentName,
      filter_reason: filterReason,
    });

    appendFileSync(join(logDir, 'filtered-inbound.jsonl'), entry + '\n', 'utf-8');
  } catch {
    // Diagnostics are best-effort; never break the poller on a log write failure.
  }
}

/**
 * Append a raw Telegram update (the full payload from `getUpdates`) to a
 * day-rotated JSONL archive. This is the "we don't know what Telegram
 * actually sent us" diagnostic surface — every poll-cycle update is
 * recorded verbatim so future debugging rounds (privacy-mode quirks,
 * unrecognised entity types, new service-message shapes) have ground
 * truth instead of guesswork.
 *
 * Path: `{ctxRoot}/logs/{agentName}/telegram-updates-YYYY-MM-DD.jsonl`
 *
 * Rotated daily by date in filename. Existing inbound-messages.jsonl is
 * single-file-ever; raw updates rotate because they are MUCH noisier
 * (every getUpdates result lands here, including no-op heartbeat-style
 * empty payloads if Telegram ever ships them). Daily rotation is cheap
 * insurance against unbounded growth.
 *
 * Write failures are silently swallowed — diagnostics are nice-to-have
 * and must never break message processing.
 */
export function recordRawTelegramUpdate(
  ctxRoot: string,
  agentName: string,
  update: TelegramUpdate,
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = join(logDir, `telegram-updates-${today}.jsonl`);

    const entry = JSON.stringify({
      received_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      update_id: update.update_id,
      update,
    });

    appendFileSync(filePath, entry + '\n', 'utf-8');
  } catch {
    // Diagnostics are best-effort; never break the poller on a log write failure.
  }
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
