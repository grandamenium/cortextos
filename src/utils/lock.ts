import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

/**
 * How long a lock directory may exist WITHOUT a readable PID file before it is
 * treated as abandoned.
 *
 * The legitimate window between `mkdirSync` and `writeFileSync` below is
 * sub-millisecond. A lock directory that has sat pid-less for 30 seconds is not
 * a holder mid-acquire — it is a process that died in that gap. Without this
 * bound such a directory blocks its channel FOREVER, and because
 * `checkInbox` historically reported a failed acquire as an empty inbox, the
 * symptom was silent: an orchestrator inbox wedged on 2026-06-22 swallowed 65
 * agent messages over six weeks before anyone noticed.
 *
 * Keep this comfortably larger than any plausible mkdir→write scheduling delay
 * and comfortably smaller than a human noticing a wedged queue.
 */
const PID_WRITE_GRACE_MS = 30_000;

/** Age of the lock directory in ms, or 0 if it cannot be stat'd (treat as fresh). */
function lockAgeMs(lockDir: string): number {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    // Vanished between our mkdir attempt and now — another process is actively
    // churning it. Report "fresh" so the caller retries rather than steals.
    return 0;
  }
}

/** Remove an abandoned lock directory and take it over. */
function stealLock(lockDir: string, pidFile: string): boolean {
  try {
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch {
    // Another process beat us to the steal — let the caller retry.
    return false;
  }
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Automatically recovers stale locks — both the dead-PID case and the
 * pid-less case where a process died mid-acquire (see PID_WRITE_GRACE_MS).
 */
export function acquireLock(dir: string): boolean {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');

  try {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (err) {
    // Only EEXIST means contention. EACCES / ENOSPC / EROFS / etc. are real
    // filesystem failures — propagate so the caller (withFileLockSync) does
    // not loop forever against a directory that will never be writable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // mkdirSync failed with EEXIST — another process holds (or is mid-acquire
    // of) the lock.  We must NOT treat the gap between mkdirSync and
    // writeFileSync as "stale" — doing so allows two acquirers to interleave
    // and BOTH believe they hold the lock (the actual race that broke iter
    // 12).  When the PID file is missing, the holder is mid-acquire; the
    // caller should retry.
    let storedPidRaw: string;
    try {
      storedPidRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      // PID file not yet written. Either the holder is between mkdir and
      // writeFileSync (sub-millisecond), or it DIED in that gap and left an
      // empty lock directory that would otherwise block this channel forever.
      // Age is what distinguishes the two — refusing unconditionally, as this
      // did before, is what wedged the agent inbox for six weeks.
      if (lockAgeMs(lockDir) > PID_WRITE_GRACE_MS) {
        return stealLock(lockDir, pidFile);
      }
      // Genuinely mid-acquire — the caller's retry loop will try again.
      return false;
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // Corrupt PID file. Same reasoning as above: retry while it is young,
      // but never let a permanently corrupt file wedge the lock forever.
      if (lockAgeMs(lockDir) > PID_WRITE_GRACE_MS) {
        return stealLock(lockDir, pidFile);
      }
      return false;
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead - stale lock, remove and re-acquire atomically.
      return stealLock(lockDir, pidFile);
    }
  }
}

/**
 * Release a mutex lock.
 */
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore errors on release
  }
}

/**
 * Inter-process lock options for `withFileLockSync`.
 */
export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

// SharedArrayBuffer + Atomics.wait gives us a clean cross-thread sleep
// from sync code without spinning the CPU.  One module-scoped buffer is
// reused across calls; we never write to it (only sleep on a wait that
// always times out at `ms`).
const SLEEP_SAB  = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

/**
 * Acquire `dir`'s mutex, run `fn`, then release the lock — even if `fn`
 * throws.  Retries with exponential backoff (capped) until `timeoutMs`.
 *
 * Use this around any read-modify-write sequence on a per-agent file
 * (crons.json etc.) so two concurrent processes can't lose each other's
 * mutations between the read and the write (the atomic rename in
 * writeCrons is per-write only — it does NOT make the surrounding
 * read-modify-write transactional).
 *
 * @throws if the lock cannot be acquired within `timeoutMs`.
 */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs    = opts.timeoutMs        ?? 5_000;
  const initBackoff  = opts.initialBackoffMs ?? 5;
  const maxBackoff   = opts.maxBackoffMs     ?? 100;

  // Use process.hrtime.bigint() instead of Date.now() so the timeout works
  // under vi.useFakeTimers() (which freezes Date.now).  hrtime reads the
  // monotonic clock via syscall and is not stubbed by fake-timer libraries.
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  while (!acquireLock(dir)) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${dir}" within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    releaseLock(dir);
  }
}
