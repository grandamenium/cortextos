import { writeFileSync, readFileSync, rmSync, linkSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Matches a lock link-temp left by a crashed acquirer: `.lock.<pid>.<uuid>.tmp`.
const LOCK_TMP_RE = /^\.lock\.(\d+)\.[0-9a-fA-F-]+\.tmp$/;

type HolderState =
  | { state: 'gone' }                              // no lock file
  | { state: 'alive'; pid: number }                // held by a live process
  | { state: 'recoverable'; pid: number | null };  // dead / empty / corrupt → reclaimable

/**
 * True iff `pid` names a process that currently EXISTS. `process.kill(pid, 0)`
 * succeeding means alive; ESRCH means dead; EPERM means the process exists but we
 * may not signal it (e.g. a different user) — still ALIVE. So a live holder is
 * never mistaken for dead, even in a mixed-user deployment.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Classify the current holder of a lock file by reading + liveness-checking its pid. */
function readHolder(lockFile: string): HolderState {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf-8').trim();
  } catch {
    return { state: 'gone' };
  }
  if (raw === '') return { state: 'recoverable', pid: null };
  const pid = parseInt(raw, 10);
  if (Number.isNaN(pid)) return { state: 'recoverable', pid: null };
  return isProcessAlive(pid) ? { state: 'alive', pid } : { state: 'recoverable', pid };
}

/**
 * Atomically + windowlessly create `lockFile` holding our pid: write the pid to a
 * uniquely-named temp, then hardlink it into place — `linkSync` is atomic and the
 * lock springs into existence ALREADY holding the pid (a hardlink to the complete
 * temp), so there is NO instant where the lock exists pid-less. Returns 'acquired'
 * or 'exists' (already held). Real fs errors propagate.
 *
 * (A lighter `writeFileSync(lock, pid, {flag:'wx'})` variant also kills the
 * deadlock but reopens a microscopic open→write window; the hardlink-temp form is
 * windowless and chosen for the strongest guarantee on this critical primitive.)
 */
function tryLink(lockFile: string): 'acquired' | 'exists' {
  // Temp lives beside its lock, derived from the lock path: `.lock` →
  // `.lock.<pid>.<uuid>.tmp`. randomUUID → unique even across same-PID worker
  // threads/isolates; 'wx' refuses to clobber any (astronomically unlikely) collision.
  const tmpFile = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpFile, String(process.pid), { flag: 'wx' });
  try {
    linkSync(tmpFile, lockFile);
    return 'acquired';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return 'exists';
  } finally {
    try { unlinkSync(tmpFile); } catch { /* after a successful link the lock survives via its own hardlink */ }
  }
}

/**
 * Acquire a mutex lock. Returns true if acquired, false if another LIVE process
 * holds it (the caller's retry loop re-tries). A dead/empty/corrupt holder is
 * removed (best-effort) so the next attempt re-links. Real filesystem failures
 * propagate so callers do not spin against a path that will never be writable.
 *
 * KNOWN RESIDUAL (recovery TOCTOU — pre-existing; full fix tracked in the
 * serialized-recovery-mutex/mtime-staleness design task): the `readHolder` check
 * and the `rmSync` below are NOT atomic. Under adversarial scheduling a CONCURRENT
 * recoverer can remove the dead lock and a peer re-acquire a fresh LIVE lock in
 * the gap, which this `rmSync` would then delete → a rare double-hold. This is
 * inherent to recover-by-delete on a CAS-less filesystem (atomic-rename and a
 * naive recovery-mutex were both proven not to close it). It is bounded in
 * practice by the FastChecker context restart circuit-breaker and is the same
 * residual the base mutex carried — these changes do NOT touch it.
 */
export function acquireLock(dir: string): boolean {
  const lockFile = join(dir, '.lock');
  if (tryLink(lockFile) === 'acquired') return true;
  // Held — inspect the holder.
  const holder = readHolder(lockFile);
  if (holder.state === 'alive') return false; // live holder — caller retries / waits
  if (holder.state === 'gone') return false;  // released concurrently — caller retries
  // Dead/empty/corrupt — best-effort remove so the next attempt re-links (see the
  // KNOWN RESIDUAL note above). `rmSync(force)` never throws on ENOENT.
  try { rmSync(lockFile, { force: true }); } catch { /* a concurrent recoverer won — fine */ }
  return false;
}

/**
 * Release a mutex lock — IDENTITY-SAFE: only removes `.lock` if WE own it (its
 * pid is ours). A process therefore never releases a lock it no longer holds
 * (e.g. one already recovered + re-acquired by a peer), and never deletes a
 * foreign owner's lock.
 */
export function releaseLock(dir: string): void {
  const lockFile = join(dir, '.lock');
  try {
    if (readFileSync(lockFile, 'utf-8').trim() === String(process.pid)) {
      rmSync(lockFile, { force: true });
    }
  } catch {
    // No lock / unreadable — nothing to release.
  }
}

/**
 * Sweep orphan lock temp files (`.lock.<pid>.<uuid>.tmp`) left by a writer that
 * crashed between `writeFileSync(temp)` and the
 * finally-unlink. Because temps now carry a random name they are never reused or
 * overwritten, so they would otherwise accumulate. Removal is doubly-gated:
 *  - AGE: only temps older than `maxAgeMs` (a fresh temp may be an in-flight acquire);
 *  - IDENTITY: only temps whose owner pid is dead (NEVER a live owner's temp).
 * Returns the number swept. Read-mostly + best-effort; never throws.
 */
export function sweepOrphanLockTemps(dir: string, maxAgeMs = 5 * 60_000): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let swept = 0;
  for (const f of entries) {
    const m = LOCK_TMP_RE.exec(f);
    if (!m) continue;
    const full = join(dir, f);
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue; // too fresh — may be in-flight
    } catch {
      continue;
    }
    const pid = parseInt(m[1], 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid)) continue; // live owner — keep its in-flight temp
    try { unlinkSync(full); swept++; } catch { /* already gone */ }
  }
  return swept;
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
