import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, renameSync, statSync } from 'fs';
import { join } from 'path';

// Max age for a lock with an empty/corrupt PID file before it is treated as
// stale and stolen. A legitimate mid-acquire window (mkdir → writeFileSync)
// completes in <1ms; 30 seconds is a safe upper bound that avoids stealing
// live locks while ensuring a crash-orphaned empty-PID lock is recovered.
const EMPTY_PID_STALE_MS = 30_000;

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Automatically recovers stale locks (dead process).
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
      // PID file not yet written.  Holder is between mkdir and writeFileSync.
      // Refuse the lock — the caller's retry loop will try again.
      return false;
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // Empty or corrupt PID file. The holder crashed between mkdir and
      // writeFileSync. If the lock directory is old enough (> EMPTY_PID_STALE_MS)
      // it cannot be a live mid-acquire window — steal it. If it is very
      // recent, refuse so we don't race a concurrent live acquirer.
      try {
        const lockStat = statSync(lockDir);
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs < EMPTY_PID_STALE_MS) {
          return false; // Still within the legitimate mid-acquire window
        }
        // Old enough to be stale — fall through to the steal logic below.
      } catch {
        return false; // Can't stat the lock dir — let caller retry
      }
      // Steal the stale empty-PID lock atomically.
      const tmpStealDir = join(dir, `.lock.d.steal-${process.pid}-${Date.now()}`);
      try {
        renameSync(lockDir, tmpStealDir);
        rmSync(tmpStealDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        return false;
      }
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead — stale lock. Steal it atomically via rename(2).
      //
      // renameSync is atomic on POSIX: exactly one process wins when N
      // concurrent stealers all try to rename the same source path. The
      // winner gets the stale dir under a unique temp name; losers get
      // ENOENT (source already renamed) and fall back to the retry loop.
      //
      // This closes a double-steal race in the previous rmSync+mkdirSync
      // approach: two concurrent stealers could each do rmSync (one a
      // no-op), then both win mkdirSync in sequence because the first
      // winner's lock dir got wiped by the second stealer's rmSync.
      const tmpStealDir = join(dir, `.lock.d.steal-${process.pid}-${Date.now()}`);
      try {
        renameSync(lockDir, tmpStealDir);
        // We won the rename — exclusively own tmpStealDir. Clean it up and
        // create the canonical lock dir with our PID.
        rmSync(tmpStealDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        // rename failed — either another stealer beat us (ENOENT) or a
        // normal waiter created the lock dir between our check and rename
        // (EEXIST on mkdirSync). Either way, let the caller retry.
        return false;
      }
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
