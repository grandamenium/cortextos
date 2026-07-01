import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Recover a lock whose holder died before writing a valid PID.
 *
 * Called from the two acquireLock branches where the PID file is missing or
 * unparseable. Those states are legitimate for the microseconds between
 * mkdirSync(lockDir) and writeFileSync(pid) — but a holder that died in that
 * window leaves them behind FOREVER, and the PID-liveness stale check can
 * never run (there is no PID to check). Without an age-based escape hatch,
 * every subsequent acquire returns false and the resource deadlocks
 * permanently (2026-07-01: 8 agent inboxes silently wedged for days).
 *
 * Must return true ONLY if the lock was stolen and re-acquired for this
 * process (lockDir recreated, pid file written with process.pid).
 * Returning false means "holder may still be mid-acquire — let caller retry."
 */
// 30s is ~6 orders of magnitude above the real mkdir→writeFile gap, generous
// even for a swapping/paused acquirer, while keeping recovery bounded for the
// 1s-poll FastChecker (vs. the permanent wedge this replaces).
const STALE_LOCK_MS = 30_000;

function tryStealStaleLock(lockDir: string, pidFile: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    // Lock dir vanished — holder released between our EEXIST and the stat.
    // Let caller retry.
    return false;
  }

  if (ageMs < STALE_LOCK_MS) {
    // Plausibly a live holder mid-acquire — let caller retry.
    return false;
  }

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
      // PID file not yet written.  Holder is between mkdir and writeFileSync —
      // or died there and will never write it.  Refuse while the lock is
      // fresh (caller retries); steal once it is unambiguously stale.
      return tryStealStaleLock(lockDir, pidFile);
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // Corrupt/empty PID file.  A live holder rewrites it within µs, so a
      // persistent one means the holder died mid-write.  The liveness check
      // below can never run without a PID — age is the only recovery signal.
      return tryStealStaleLock(lockDir, pidFile);
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
