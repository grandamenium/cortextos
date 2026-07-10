import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Age (by lock-dir mtime) past which a lock is presumed abandoned and may be
 * reclaimed regardless of its pid file state. Every critical section guarded
 * by these locks is a short read-modify-write (milliseconds), so 60s is ~3-4
 * orders of magnitude above any legitimate hold time.
 */
const DEFAULT_STALE_LOCK_MS = 60_000;

/**
 * Options for `acquireLock`.
 */
export interface AcquireLockOptions {
  /**
   * Age in ms past which an existing `.lock.d` is treated as abandoned and
   * reclaimed even when its pid file is missing, empty, corrupt, or names a
   * live pid (crashed holders can leave any of those states behind; a live
   * pid can be a recycled one). Default 60000.
   */
  staleMs?: number;
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Automatically recovers stale locks: a lock whose pid is dead is reclaimed
 * immediately; a lock whose pid file is missing/empty/corrupt — or whose pid
 * reads alive (possibly recycled) — is reclaimed once it is older than
 * `staleMs`, so a holder that crashed mid-acquire cannot wedge the resource
 * forever.
 */
export function acquireLock(dir: string, opts: AcquireLockOptions = {}): boolean {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_LOCK_MS;
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
    // caller should retry.  BUT a holder that crashed inside that gap leaves
    // the lock in this state forever (a 0-byte pid file once blackholed an
    // agent inbox for 4 days), so past `staleMs` the lock is reclaimed —
    // a healthy holder is only mid-acquire for microseconds.
    let storedPidRaw: string | null;
    try {
      storedPidRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      // PID file not yet written: holder mid-acquire, or crashed in the gap.
      storedPidRaw = null;
    }

    const storedPid =
      storedPidRaw === null || storedPidRaw === '' ? NaN : parseInt(storedPidRaw, 10);

    if (isNaN(storedPid)) {
      // Missing/empty/corrupt pid file. Young → assume mid-acquire, let the
      // caller retry. Older than staleMs → abandoned, reclaim.
      if (!isLockStale(lockDir, staleMs)) {
        return false;
      }
      return stealLock(lockDir, pidFile, 'pid file missing or corrupt past stale threshold');
    }

    // Check if the recorded process is still alive.
    let alive = true;
    try {
      process.kill(storedPid, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      // Process is dead — stale lock, reclaim.
      return stealLock(lockDir, pidFile, `holder pid ${storedPid} is dead`);
    }

    // Pid reads alive, but pids are recycled and holders can hang: a lock
    // older than staleMs is broken no matter what its pid file says.
    if (isLockStale(lockDir, staleMs)) {
      return stealLock(lockDir, pidFile, `held past stale threshold by pid ${storedPid}`);
    }

    // Live, young lock — genuinely held.
    return false;
  }
}

/**
 * True when the lock dir's mtime is more than `staleMs` in the past. The dir
 * is never touched after acquisition, so its mtime is the acquisition time.
 */
function isLockStale(lockDir: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    // Lock vanished (holder released it) — not stale; caller retries the
    // normal acquire path.
    return false;
  }
}

/**
 * Reclaim a lock decided to be stale. The steal is done by renaming the lock
 * dir aside first: rename is atomic, so of N concurrent stealers exactly one
 * succeeds — a lock freshly re-acquired by the winner cannot be destroyed by
 * a loser still acting on a stale decision (a plain rm+mkdir steal has that
 * hole). Returns true if we now hold the lock.
 */
function stealLock(lockDir: string, pidFile: string, reason: string): boolean {
  const tombstone = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, tombstone);
  } catch {
    // Someone else reclaimed or released it first — let the caller retry.
    return false;
  }
  console.warn(`[utils/lock] reclaimed stale lock ${lockDir} (${reason})`);
  try {
    rmSync(tombstone, { recursive: true, force: true });
  } catch {
    // Best effort — the '.'-prefixed tombstone is invisible to inbox scans.
  }
  try {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch {
    // Another acquirer got the fresh slot first — let the caller retry.
    return false;
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
  /** Stale-lock reclaim age passed through to acquireLock. Default 60000ms. */
  staleLockMs?: number;
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

  while (!acquireLock(dir, { staleMs: opts.staleLockMs })) {
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
