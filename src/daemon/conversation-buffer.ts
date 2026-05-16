/**
 * Rolling conversation buffer across agent restarts.
 *
 * Persists every Josh↔agent Telegram exchange (and any other bus channel
 * wired in) as a JSONL stream. The buffer file holds at most N entries
 * (default 20). Older entries are moved to an append-only archive so the
 * literal record survives indefinitely while the active buffer stays
 * cheap to load on session start.
 *
 * Buffer path:  ${ctxRoot}/state/${agentName}/conversation-buffer.jsonl
 * Archive path: ${ctxRoot}/state/${agentName}/conversation-buffer-archive.jsonl
 *
 * See `.planning/larry-ux-parity-spec.md` → "Item 2: Rolling conversation
 * buffer across restarts" for acceptance criteria.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ConversationBufferEntry } from '../types/index.js';

/**
 * Default rolling window size. Spec recommends N=20 — large enough to
 * cover Josh's last several turns plus the agent's responses, small
 * enough to read on every session start without bloating context.
 */
export const DEFAULT_BUFFER_LIMIT = 20;

interface BufferPaths {
  dir: string;
  buffer: string;
  archive: string;
}

function resolveBufferPaths(ctxRoot: string, agentName: string): BufferPaths {
  const dir = join(ctxRoot, 'state', agentName);
  return {
    dir,
    buffer: join(dir, 'conversation-buffer.jsonl'),
    archive: join(dir, 'conversation-buffer-archive.jsonl'),
  };
}

/**
 * Read the current buffer file and return parsed entries.
 * Malformed lines are skipped silently (defensive — the buffer is
 * append-only but external editors or crashes mid-write could leave a
 * partial line).
 */
function readBufferEntries(path: string): ConversationBufferEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return [];
  const out: ConversationBufferEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ConversationBufferEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Append an exchange entry to the buffer.
 *
 * Both Josh→agent (sender:"josh") and agent→Josh (sender:agentName)
 * messages flow through here. On every write we check whether the
 * buffer now exceeds `limit` entries; if so, the oldest excess entries
 * are moved to the archive file (append-only) and the buffer is
 * rewritten with the trailing `limit` entries.
 *
 * This guarantees `conversation-buffer.jsonl` has at most `limit`
 * entries at rest, while the archive preserves the full history.
 *
 * Errors are caught and ignored — buffer failures must never block
 * the actual Telegram send/receive path.
 */
export function appendToBuffer(
  ctxRoot: string,
  agentName: string,
  entry: ConversationBufferEntry,
  limit: number = DEFAULT_BUFFER_LIMIT,
): void {
  try {
    const { dir, buffer, archive } = resolveBufferPaths(ctxRoot, agentName);
    mkdirSync(dir, { recursive: true });

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(buffer, line, 'utf-8');

    const entries = readBufferEntries(buffer);
    if (entries.length <= limit) return;

    // Rotate: move oldest excess to archive, rewrite buffer with tail.
    const excess = entries.slice(0, entries.length - limit);
    const keep = entries.slice(entries.length - limit);

    const archiveLines = excess.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(archive, archiveLines, 'utf-8');

    const bufferLines = keep.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(buffer, bufferLines, 'utf-8');
  } catch {
    // Never throw from the buffer path — Telegram flow must continue.
  }
}

/**
 * Load the last `limit` entries from the buffer.
 *
 * Called from the session-start protocol (AGENTS.md step 7.5) so the
 * agent boots with literal recent turns in context — not just the
 * compressed handoff doc.
 *
 * Returns [] when the buffer file doesn't exist yet (first boot) or
 * is unreadable.
 */
export function loadBuffer(
  ctxRoot: string,
  agentName: string,
  limit: number = DEFAULT_BUFFER_LIMIT,
): ConversationBufferEntry[] {
  try {
    const { buffer } = resolveBufferPaths(ctxRoot, agentName);
    const entries = readBufferEntries(buffer);
    if (entries.length <= limit) return entries;
    return entries.slice(entries.length - limit);
  } catch {
    return [];
  }
}
