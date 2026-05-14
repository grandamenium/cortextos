/**
 * P6 Duplicate Suppression
 *
 * Before a Telegram message is sent, check the last 5 outbound entries for
 * the same chat_id. If any was sent within 60 seconds and has >70% Jaccard
 * token overlap with the new message, suppress the send and return isDuplicate.
 *
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface OutboundEntry {
  timestamp: string;
  chat_id: string;
  text: string;
}

/**
 * Compute Jaccard similarity between two strings based on token sets.
 * Tokens are whitespace-split, lowercased, and deduplicated.
 */
export function jaccardTokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = s.toLowerCase().split(/\s+/).filter(Boolean);
    return new Set(tokens);
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Read the last N lines of outbound-messages.jsonl for a specific chat_id.
 */
function readLastOutbound(
  ctxRoot: string,
  agentName: string,
  chatId: string,
  limit: number,
): OutboundEntry[] {
  const path = join(ctxRoot, 'logs', agentName, 'outbound-messages.jsonl');
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n').filter(Boolean);
  const results: OutboundEntry[] = [];

  // Walk backwards to get most recent first
  for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]) as OutboundEntry;
      if (String(entry.chat_id) === String(chatId)) {
        results.push(entry);
      }
    } catch {
      // skip malformed lines
    }
  }

  return results;
}

export interface DedupResult {
  isDuplicate: boolean;
  /** Timestamp of the matched prior message, if a duplicate was found. */
  matchedTimestamp?: string;
  /** Jaccard similarity score that triggered suppression, if a duplicate was found. */
  matchedScore?: number;
}

/**
 * Check whether `message` is a near-duplicate of a recently sent outbound
 * message for the given chatId.
 *
 * Returns { isDuplicate: true } if any of the last 5 outbound messages for
 * this chat_id was sent within 60 seconds and shares >70% Jaccard token
 * overlap with the new message.
 */
export function checkDuplicate(
  ctxRoot: string,
  agentName: string,
  chatId: string,
  message: string,
): DedupResult {
  const recent = readLastOutbound(ctxRoot, agentName, chatId, 5);
  const now = Date.now();
  const windowMs = 60_000;

  for (const entry of recent) {
    const sentAt = new Date(entry.timestamp).getTime();
    if (isNaN(sentAt)) continue;

    const ageMs = now - sentAt;
    if (ageMs > windowMs) continue;

    const score = jaccardTokenSimilarity(message, entry.text);
    if (score > 0.7) {
      return { isDuplicate: true, matchedTimestamp: entry.timestamp, matchedScore: score };
    }
  }

  return { isDuplicate: false };
}
