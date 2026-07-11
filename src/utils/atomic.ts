import { writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, appendFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Atomically append a single line to a JSONL file using a lockfile.
 * On Windows, appendFileSync is not atomic under concurrent writers (two
 * processes can seek to the same EOF and overwrite each other). The lockfile
 * serialises concurrent appenders without requiring external dependencies.
 *
 * Lock path: <filePath>.lock  — created with O_EXCL (exclusive create, fails
 * if it already exists).  Stale locks older than 5 s are broken automatically.
 */
export function atomicAppendLineSync(filePath: string, line: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const lockPath = filePath + '.lock';
  const LOCK_TTL_MS = 5000;
  const RETRY_INTERVAL_MS = 20;
  const MAX_RETRIES = 100; // 2 seconds total

  let acquired = false;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      // O_EXCL | O_CREAT: atomic on NTFS and POSIX — fails if file exists
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      acquired = true;
      break;
    } catch {
      // Lock held — check for stale lock
      try {
        const { statSync } = require('fs');
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          try { unlinkSync(lockPath); } catch { /* ignore */ }
        }
      } catch { /* lock may have just been released */ }
      // Busy-wait
      const until = Date.now() + RETRY_INTERVAL_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }

  try {
    appendFileSync(filePath, line + '\n', 'utf-8');
  } finally {
    if (acquired) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
