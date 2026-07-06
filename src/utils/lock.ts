import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';

const STALE_PID_GRACE_MS = 500;
let claimSeq = 0;

type ObservedOwner =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'dead'; pid: number }
  | { kind: 'live'; pid: number };

function nextClaimSeq(): number {
  claimSeq += 1;
  return claimSeq;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function readObservedOwner(pidFile: string): ObservedOwner {
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf-8').trim();
  } catch {
    return { kind: 'missing' };
  }

  if (raw === '') {
    return { kind: 'corrupt' };
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'corrupt' };
  }

  return isPidAlive(parsed)
    ? { kind: 'live', pid: parsed }
    : { kind: 'dead', pid: parsed };
}

function matchesExpectedOwner(observed: ObservedOwner, expected: Exclude<ObservedOwner, { kind: 'live'; pid: number }>): boolean {
  if (expected.kind === 'missing') {
    return observed.kind === 'missing';
  }
  if (expected.kind === 'corrupt') {
    return observed.kind === 'corrupt';
  }
  return observed.kind === 'dead' && observed.pid === expected.pid;
}

function restoreClaim(lockDir: string, pidFile: string, claimPath: string): boolean {
  try {
    renameSync(claimPath, lockDir);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
      throw err;
    }
  }

  const claimPidFile = join(claimPath, 'pid');
  let owner: string;
  try {
    owner = readFileSync(claimPidFile, 'utf-8');
  } catch {
    return false;
  }

  while (true) {
    try {
      writeFileSync(pidFile, owner, { flag: 'wx' });
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        continue;
      }
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        return false;
      }
      throw err;
    }
  }
}

function stealLock(
  lockDir: string,
  pidFile: string,
  expectedOwner: Exclude<ObservedOwner, { kind: 'live'; pid: number }>,
): boolean {
  const currentAge = lockAgeMs(lockDir);
  if (currentAge === null) {
    return false;
  }
  const currentOwner = readObservedOwner(pidFile);
  if (!matchesExpectedOwner(currentOwner, expectedOwner)) {
    return false;
  }
  if ((currentOwner.kind === 'missing' || currentOwner.kind === 'corrupt') && currentAge < STALE_PID_GRACE_MS) {
    return false;
  }

  if (expectedOwner.kind === 'dead') {
    const claimPidFile = join(dirname(lockDir), `.lock.pid.claim.${process.pid}.${nextClaimSeq()}`);
    try {
      renameSync(pidFile, claimPidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return false;
      }
      throw err;
    }

    try {
      const claimedOwner = readObservedOwner(claimPidFile);
      if (!matchesExpectedOwner(claimedOwner, expectedOwner)) {
        let owner: string;
        try {
          owner = readFileSync(claimPidFile, 'utf-8');
        } catch {
          return false;
        }

        while (true) {
          try {
            writeFileSync(pidFile, owner, { flag: 'wx' });
            return false;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              continue;
            }
            if (code === 'EEXIST' || code === 'ENOTEMPTY') {
              return false;
            }
            throw err;
          }
        }
      }

      writeFileSync(claimPidFile, String(process.pid));

      while (true) {
        try {
          writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
          return true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            continue;
          }
          if (code === 'EEXIST' || code === 'ENOTEMPTY') {
            return false;
          }
          throw err;
        }
      }
    } finally {
      try { rmSync(claimPidFile, { force: true }); } catch { /* ignore */ }
    }
  }

  const claimPath = join(dirname(lockDir), `.lock.d.claim.${process.pid}.${nextClaimSeq()}`);
  try {
    renameSync(lockDir, claimPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  try {
    const claimPidFile = join(claimPath, 'pid');
    const claimedOwner = readObservedOwner(claimPidFile);
    if (!matchesExpectedOwner(claimedOwner, expectedOwner)) {
      return restoreClaim(lockDir, pidFile, claimPath);
    }

    if (claimedOwner.kind === 'missing' || claimedOwner.kind === 'corrupt') {
      const claimAge = lockAgeMs(claimPath);
      if (claimAge === null || claimAge < STALE_PID_GRACE_MS) {
        return restoreClaim(lockDir, pidFile, claimPath);
      }
    }

    writeFileSync(claimPidFile, String(process.pid));

    try {
      mkdirSync(lockDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') {
        return false;
      }
      throw err;
    }

    while (true) {
      try {
        writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          continue;
        }
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          return false;
        }
        throw err;
      }
    }
  } finally {
    try { rmSync(claimPath, { recursive: true, force: true }); } catch { /* ignore */ }
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
    const ageMs = lockAgeMs(lockDir);
    if (ageMs === null) {
      // The holder released .lock.d between mkdir contention and our probe.
      // Treat that as a normal retry window, not as a hard failure.
      return false;
    }
    const owner = readObservedOwner(pidFile);

    if (owner.kind === 'live') {
      // Process is alive - lock is held
      return false;
    }

    if ((owner.kind === 'missing' || owner.kind === 'corrupt') && ageMs < STALE_PID_GRACE_MS) {
      // Give a genuine mid-acquire writer a short grace window to finish.
      return false;
    }

    return stealLock(lockDir, pidFile, owner);
  }
}

/**
 * Release a mutex lock.
 */
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const owner = parseInt(raw, 10);
    // Only the owning process (or a dead/corrupt owner) may clear the lock.
    if (!isNaN(owner) && owner !== process.pid && isPidAlive(owner)) {
      return;
    }
  } catch {
    // Missing or corrupt owner data is safe to clear.
  }
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
