import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

/**
 * How long a lock whose PID cannot be read may sit before it is treated as
 * abandoned and broken.
 *
 * A live holder occupies the unreadable-PID window only between `mkdirSync`
 * and `writeFileSync` — microseconds. A process killed inside that window (a
 * hard shutdown, OOM, `kill -9`) leaves the lock dir with an empty or absent
 * PID file and nothing to check for liveness, so the PID-based staleness test
 * below can never fire. Without an age bound that lock is held forever and the
 * directory is silently unusable for the life of the machine.
 *
 * Any value orders of magnitude above the real mkdir→write window and below
 * "a human would notice" works; 30s is far outside the former and inside the
 * latter, so a legitimate mid-acquire holder cannot be robbed.
 */
export const LOCK_STALE_MS = 30_000;

/** Why a lock could not be acquired — lets callers distinguish live contention from a broken lock. */
export interface LockHeldInfo {
  /** PID recorded in the lock, if one could be read. */
  pid?: number;
  /** Age of the lock directory in ms. */
  ageMs: number;
  /** True when the PID file is missing/empty/corrupt (holder died mid-acquire). */
  pidUnreadable: boolean;
}

/**
 * Inspect a lock without attempting to take it.
 *
 * Returns `null` when no lock is present. Callers that must not confuse
 * "nothing to do" with "could not look" (see `checkInbox`) use this to tell
 * the two apart.
 */
export function inspectLock(dir: string): LockHeldInfo | null {
  const lockDir = join(dir, '.lock.d');
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null; // no lock
  }

  let pid: number | undefined;
  let pidUnreadable = true;
  try {
    const raw = readFileSync(join(lockDir, 'pid'), 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (raw !== '' && !isNaN(parsed)) {
      pid = parsed;
      pidUnreadable = false;
    }
  } catch {
    // leave pidUnreadable = true
  }

  return { pid, ageMs, pidUnreadable };
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Recovers stale locks: a dead PID, or a lock whose PID never got written
 * because the holder was killed mid-acquire (see LOCK_STALE_MS).
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
      // PID file not yet written.  Either the holder is between mkdir and
      // writeFileSync (microseconds — refuse, the caller retries), or it was
      // KILLED in that window and will never write one.  Only age separates
      // the two, and without this check the second case deadlocks forever.
      return breakIfAbandoned(lockDir, pidFile);
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // PID file present but empty/corrupt — same crash window as above (the
      // file is created before it is written), same reasoning, same bound.
      return breakIfAbandoned(lockDir, pidFile);
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead - stale lock, remove and re-acquire atomically.
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        // Another process beat us to the steal — let caller retry.
        return false;
      }
    }
  }
}

/**
 * Break a lock whose PID cannot be read, but only once it is older than
 * LOCK_STALE_MS — i.e. far past any legitimate mkdir→writeFileSync window, so
 * a live mid-acquire holder is never robbed.
 *
 * Returns true if the lock was broken and re-acquired by us.
 */
function breakIfAbandoned(lockDir: string, pidFile: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    // Lock vanished under us — the caller's retry will take it cleanly.
    return false;
  }

  if (ageMs < LOCK_STALE_MS) {
    // Plausibly a live holder mid-acquire. Refuse; caller retries.
    return false;
  }

  // Abandoned: no PID to check for liveness and far too old to be mid-acquire.
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
