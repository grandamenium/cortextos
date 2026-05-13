import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
} from 'fs';
import { join } from 'path';

/**
 * Result of inspecting an agent's Claude Code project dir for a prior
 * session stuck at the context-limit wall.
 */
export interface ContextCapDetection {
  /** True if the most recent session jsonl looks stuck at Claude Code's
   *  context-limit prompt. */
  capped: boolean;
  /** The full path of the capped session file, present only when
   *  `capped === true`. Callers rename this aside before starting a fresh
   *  session so `claude --continue` has nothing to restore. */
  sessionFile?: string;
}

/**
 * Patterns that indicate a Claude Code session is stuck at the hard
 * context-limit wall. Observed during the 2026-04-19 FRIDAY zombie
 * incident. Kept loose so variant wording from future CLI versions still
 * matches — we prefer a few rare false positives (recovered with a
 * benign fresh-session) over missing a real zombie.
 */
const CONTEXT_CAP_PATTERNS: RegExp[] = [
  /Context limit reached/i,
  /prompt is too long/i,
  /\/compact or \/clear to continue/i,
];

/**
 * Size of the tail we scan from the most recent session jsonl. 16 KB is
 * plenty for the final turn, small enough to keep this check sub-ms on
 * every restart.
 */
const TAIL_BYTES = 16 * 1024;

/**
 * Inspect `convDir` (the agent's Claude Code project directory) for
 * evidence that the most recent session ended stuck at Claude Code's
 * hard context-limit wall.
 *
 * Rationale: when an agent hits ~89% context usage, Claude Code prints
 * "Context limit reached · /compact or /clear to continue" and refuses
 * further input. Running `claude --continue` against that session
 * restores the capped state verbatim — the PTY comes up healthy from
 * the OS's perspective but the CLI is still frozen at the wall. Every
 * restart, auto-recovery, or `cortextos start` cycle just re-zombies
 * the agent. See task_1776604346524_001 for the full incident report.
 *
 * This function is how the daemon breaks the loop: if it returns
 * `{ capped: true, sessionFile }`, the caller should rename the
 * session jsonl aside (so `--continue` has nothing to restore) and set
 * the agent's `.force-fresh` marker. The next spawn is then a fresh
 * Claude Code session, not a capped continuation.
 *
 * Returns `{ capped: false }` in every non-match case — including missing
 * directory, empty directory, unreadable file, or an empty jsonl. A
 * detection failure errs on the side of preserving the session (the
 * existing behavior).
 */
export function detectContextCap(convDir: string): ContextCapDetection {
  if (!existsSync(convDir)) return { capped: false };

  let entries: string[];
  try {
    entries = readdirSync(convDir);
  } catch {
    return { capped: false };
  }

  const sessions: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(convDir, name);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      sessions.push({ path: p, mtime: st.mtimeMs });
    } catch {
      // skip unreadable entry
    }
  }

  if (sessions.length === 0) return { capped: false };

  sessions.sort((a, b) => b.mtime - a.mtime);
  const latest = sessions[0];

  let tail: string;
  try {
    const st = statSync(latest.path);
    const readBytes = Math.min(TAIL_BYTES, st.size);
    const start = st.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(latest.path, 'r');
    try {
      readSync(fd, buf, 0, readBytes, start);
    } finally {
      closeSync(fd);
    }
    tail = buf.toString('utf-8');
  } catch {
    return { capped: false };
  }

  const capped = CONTEXT_CAP_PATTERNS.some((re) => re.test(tail));
  return capped ? { capped: true, sessionFile: latest.path } : { capped: false };
}

/**
 * Rename a capped session jsonl to a sibling path that `claude
 * --continue` will not pick up. Returns the archived path on success,
 * or null on failure (file missing, rename failed). Callers treat null
 * as "leave it alone and proceed normally" — losing the session archive
 * is worse than losing the chance to rescue the agent.
 */
export function archiveCappedSession(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = `${sessionFile}.capped-${stamp}`;
  try {
    renameSync(sessionFile, archivePath);
    return archivePath;
  } catch {
    return null;
  }
}
