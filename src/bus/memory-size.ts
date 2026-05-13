/**
 * MEMORY.md size enforcement for agent long-term memory files.
 *
 * The MEMORY.md index has a hard rendering limit (~24.4 KB / ~200 lines).
 * This module runs on each daemon heartbeat cycle to warn before the limit
 * is reached and auto-archive stale entries when the index grows too large.
 *
 * Thresholds:
 *   >70% (17.1 KB) — log memory_size_warning event
 *   >90% (22.0 KB) — auto-archive entries whose referenced files are >60 days old
 *
 * Archive destination: MEMORY-archive-YYYY-MM.md in the same directory as MEMORY.md.
 * Archived entries are moved out of the index; the referenced detail files are left in place.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { ensureDir } from '../utils/atomic.js';

const LIMIT_BYTES = 24_400;
const WARN_THRESHOLD = 0.70;
const ARCHIVE_THRESHOLD = 0.90;
const ARCHIVE_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export interface MemorySizeResult {
  bytes: number;
  pct: number;
  action: 'ok' | 'warning' | 'archived';
  archivedCount?: number;
}

/**
 * Check MEMORY.md size for a given agent directory.
 * Returns a result describing what action (if any) was taken.
 * Callers are responsible for logging the event.
 */
export function checkMemorySize(agentDir: string): MemorySizeResult {
  const memoryPath = join(agentDir, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    return { bytes: 0, pct: 0, action: 'ok' };
  }

  const content = readFileSync(memoryPath, 'utf-8');
  const bytes = Buffer.byteLength(content, 'utf-8');
  const pct = bytes / LIMIT_BYTES;

  if (pct < WARN_THRESHOLD) {
    return { bytes, pct, action: 'ok' };
  }

  if (pct < ARCHIVE_THRESHOLD) {
    return { bytes, pct, action: 'warning' };
  }

  // >90%: auto-archive stale entries
  const archived = archiveStaleEntries(agentDir, memoryPath, content);
  return { bytes, pct, action: 'archived', archivedCount: archived };
}

/**
 * Parse MEMORY.md index lines matching `- [Title](file.md) — description`.
 * Move entries whose referenced file has mtime >60d to MEMORY-archive-YYYY-MM.md.
 * Returns number of entries archived.
 */
function archiveStaleEntries(agentDir: string, memoryPath: string, content: string): number {
  const now = Date.now();
  const lines = content.split('\n');
  const kept: string[] = [];
  const stale: string[] = [];

  for (const line of lines) {
    const match = /^- \[.*?\]\((.+?)\)/.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }

    const relPath = match[1];
    const absPath = join(agentDir, relPath);

    try {
      if (existsSync(absPath)) {
        const { mtimeMs } = statSync(absPath);
        if (now - mtimeMs > ARCHIVE_AGE_MS) {
          stale.push(line);
          continue;
        }
      }
    } catch {
      // Unreadable stat — keep the entry
    }
    kept.push(line);
  }

  if (stale.length === 0) return 0;

  // Write archive file
  const monthStr = new Date().toISOString().slice(0, 7); // YYYY-MM
  const archivePath = join(agentDir, `MEMORY-archive-${monthStr}.md`);
  ensureDir(dirname(archivePath));
  const existing = existsSync(archivePath) ? readFileSync(archivePath, 'utf-8') : '';
  writeFileSync(archivePath, existing + stale.join('\n') + '\n', 'utf-8');

  // Rewrite MEMORY.md without stale entries
  writeFileSync(memoryPath, kept.join('\n'), 'utf-8');

  return stale.length;
}
