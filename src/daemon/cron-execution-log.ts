/**
 * cron-execution-log.ts — Per-agent cron execution log writer (Subtask 1.5).
 *
 * Appends one JSONL entry to `$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`
 * on every fire attempt (success, retry, or final failure).
 *
 * Log rotation
 * ------------
 * To prevent unbounded growth we check the file size on each append.
 * When the file exceeds ROTATION_SIZE_BYTES (200 KB) we read the file,
 * count lines, and if there are more than MAX_LOG_LINES we prune the oldest
 * entries down to MAX_LOG_LINES by atomic rename.  We do not do a full
 * read+count on every append — only when the size threshold is crossed.
 *
 * Crash safety
 * ------------
 * `fs.appendFileSync` with POSIX O_APPEND is atomic for writes smaller than
 * PIPE_BUF (~4 KB on Linux, 512 B on macOS) so individual JSONL lines are
 * safe to append without a lock.  The rotation step uses an atomic rename
 * (write to a temp file, then rename) to prevent torn reads.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type { CronExecutionLogEntry } from '../types/index.js';
import { cronExecutionLogPathFor } from '../bus/crons-schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of log entries to retain per agent after rotation. */
export const MAX_LOG_LINES = 1_000;

/**
 * Size threshold (bytes) above which we attempt log rotation.
 * 200 KB is generous for ~1 000 short JSONL lines (~200 bytes each = 200 KB).
 */
export const ROTATION_SIZE_BYTES = 200 * 1_024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the absolute path to an agent's execution log. */
function logFilePath(agentName: string): string {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  return join(ctxRoot, cronExecutionLogPathFor(agentName));
}

/** Ensure the parent directory exists. */
function ensureLogDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Prune the log file to at most MAX_LOG_LINES entries using an atomic rename.
 * Called only when the file size exceeds ROTATION_SIZE_BYTES.
 */
function rotateIfNeeded(filePath: string): void {
  try {
    const stat = statSync(filePath);
    if (stat.size <= ROTATION_SIZE_BYTES) {
      return; // still within budget — no rotation needed
    }

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    if (lines.length <= MAX_LOG_LINES) {
      return; // many large lines — size exceeded but count is fine
    }

    // Keep the most recent MAX_LOG_LINES entries (oldest are at the front)
    const pruned = lines.slice(lines.length - MAX_LOG_LINES);
    const content = pruned.join('\n') + '\n';

    // Atomic write via temp + rename
    const tmpPath = join(dirname(filePath), `.tmp.${randomBytes(6).toString('hex')}`);
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of temp file; swallow errors so logging doesn't crash
      try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  } catch {
    // Rotation errors must never crash the caller — log and move on.
    // We intentionally do not write to the log here to avoid infinite loops.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append one JSONL entry to the agent's cron execution log.
 *
 * This is the only public function; it is called by the scheduler's fire path.
 * It must not throw — any I/O error is swallowed so it never disrupts scheduling.
 *
 * @param agentName - Agent whose log file to write.
 * @param entry     - Log entry to append.
 */
export function appendExecutionLog(
  agentName: string,
  entry: CronExecutionLogEntry,
): void {
  try {
    const filePath = logFilePath(agentName);
    ensureLogDir(filePath);

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(filePath, line, { encoding: 'utf-8' });

    // Rotation check: only pay the stat cost when the file might be large.
    // This is a fast path for the common case.
    rotateIfNeeded(filePath);
  } catch {
    // Never crash the caller — execution logging is observational only.
  }
}
