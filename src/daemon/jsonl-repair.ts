// SYS-DAEMON-RESILIENCE-01 Fix 2 (mitigation ii): deterministic pre---continue
// JSONL repair. A mid-write SIGTERM when reaping an orphan can leave the Claude
// conversation .jsonl with a truncated final line. Rather than rely on
// undocumented `claude --continue` tolerance of a trailing partial (a masking
// risk if it silently chokes), we repair in our own code: drop ONLY a trailing
// segment that is both non-newline-terminated AND unparseable, leaving every
// complete record intact. No-op if already clean.

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Pure: given JSONL file content, return repaired content + whether a partial
 * trailing line was dropped.
 *
 * Safe by construction:
 *  - newline-terminated content -> nothing trailing -> no-op.
 *  - a trailing (non-newline-terminated) segment that PARSES is a complete record
 *    not yet newline-flushed -> left intact.
 *  - only a trailing segment that is BOTH unterminated AND unparseable (a genuine
 *    mid-write truncation) is dropped.
 */
export function repairTrailingPartialJsonl(content: string): { repaired: string; dropped: boolean } {
  if (content === '') return { repaired: content, dropped: false };
  const lastNl = content.lastIndexOf('\n');
  const trailing = content.slice(lastNl + 1);
  if (trailing === '') return { repaired: content, dropped: false }; // newline-terminated
  try {
    JSON.parse(trailing);
    return { repaired: content, dropped: false }; // complete record, just not flushed
  } catch {
    return { repaired: content.slice(0, lastNl + 1), dropped: true }; // truncated -> drop it
  }
}

/** Repair one JSONL file in place (atomic tmp+rename). Returns true if changed. */
export function repairJsonlFile(filePath: string): boolean {
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return false; }
  const { repaired, dropped } = repairTrailingPartialJsonl(content);
  if (!dropped) return false;
  const tmp = `${filePath}.repair.tmp`;
  writeFileSync(tmp, repaired, 'utf-8');
  renameSync(tmp, filePath);
  return true;
}

/** Repair every .jsonl in a Claude projects conversation dir. Returns the count
 *  of files changed. Missing/unreadable dir -> 0 (no-op). */
export function repairConversationDir(convDir: string): number {
  if (!existsSync(convDir)) return 0;
  let files: string[];
  try { files = readdirSync(convDir); } catch { return 0; }
  let changed = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try { if (repairJsonlFile(join(convDir, f))) changed++; } catch { /* skip a bad file */ }
  }
  return changed;
}
