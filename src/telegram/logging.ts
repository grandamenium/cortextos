/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "markdown"
 *   for the default path, "none" when the caller used --plain-text.
 * - `parseFallback`: true iff the first attempt failed with a Telegram
 *   parse-entities error and sendMessage retried with parse_mode omitted.
 * - `parseFallbackReason`: the Telegram error description that triggered
 *   the fallback, when present. Useful for auditing which agents keep
 *   generating bad markdown so we can target them for hardening.
 */
export interface OutboundLogMetadata {
  parseMode?: 'markdown' | 'none';
  parseFallback?: boolean;
  parseFallbackReason?: string;
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
  if (metadata?.parseFallback !== undefined) meta.parse_fallback = metadata.parseFallback;
  if (metadata?.parseFallbackReason !== undefined)
    meta.parse_fallback_reason = metadata.parseFallbackReason;

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
 * Append a parse-fallback event to telegram-parse-failures.jsonl (BUG-067).
 *
 * Fires when sendMessage retries with plain text after a Telegram parse-entity
 * error. Provides a durable, queryable record separate from outbound-messages.jsonl
 * so parse-failure rates can be tracked as a theta-wave metric.
 *
 * final_status:
 *   - "sent_plain"  — fallback succeeded; message delivered as plain text
 *   - "failed_both" — both Markdown and plain-text attempts failed; message lost
 *
 * Path: {ctxRoot}/logs/{agentName}/telegram-parse-failures.jsonl
 */
export function logParseFallback(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  originalText: string,
  errorMessage: string,
  finalStatus: 'sent_plain' | 'failed_both',
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      agent: agentName,
      chat_id: String(chatId),
      error_message: errorMessage,
      final_status: finalStatus,
      original_text_preview: originalText.slice(0, 200),
    });
    appendFileSync(join(logDir, 'telegram-parse-failures.jsonl'), entry + '\n', 'utf-8');
  } catch {
    // Non-critical — never block message sending on log write failures
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
 * Log a message that failed to send because Telegram was unreachable (BUG-066).
 * Path: {ctxRoot}/logs/{agentName}/narration-fallback.jsonl
 *
 * final_status:
 *   "pending"  — not yet retried
 *   "replayed" — successfully sent on recovery
 */
export function logNarrationFallback(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  errorMessage: string,
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      agent: agentName,
      chat_id: String(chatId),
      error_message: errorMessage,
      final_status: 'pending',
      text,
    });
    appendFileSync(join(logDir, 'narration-fallback.jsonl'), entry + '\n', 'utf-8');
  } catch {
    // Non-critical — never block on log write failures
  }
}

export interface NarrationFallbackEntry {
  ts: string;
  agent: string;
  chat_id: string;
  error_message: string;
  final_status: 'pending' | 'replayed';
  text: string;
}

/**
 * Read all pending narration fallback entries for an agent.
 */
export function readNarrationFallback(ctxRoot: string, agentName: string): NarrationFallbackEntry[] {
  const filePath = join(ctxRoot, 'logs', agentName, 'narration-fallback.jsonl');
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NarrationFallbackEntry)
      .filter((e) => e.final_status === 'pending');
  } catch {
    return [];
  }
}

/**
 * Clear all pending narration fallback entries (after successful replay).
 */
export function clearNarrationFallback(ctxRoot: string, agentName: string): void {
  try {
    const filePath = join(ctxRoot, 'logs', agentName, 'narration-fallback.jsonl');
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Non-critical
  }
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
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


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
