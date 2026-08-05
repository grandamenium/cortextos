import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync, renameSync } from 'fs';
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
  return inspectLockDir(join(dir, '.lock.d'));
}

/** Same, but takes the lock directory itself rather than the directory it guards. */
function inspectLockDir(lockDir: string): LockHeldInfo | null {
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
      // Process is dead — stale lock. Steal it ATOMICALLY.
      //
      // This path used to rmSync(force) + mkdirSync, which is not a steal but a
      // free-for-all: two processes can both observe the same dead PID, and the
      // second one's force-delete removes the FIRST one's freshly-created live
      // lock, after which its mkdirSync succeeds. Both then hold the lock. See
      // stealLock — rename() makes exactly one winner possible.
      return stealLock(lockDir, pidFile);
    }
  }
}

/**
 * Take over a lock that is provably not held by a live process, WITHOUT ever
 * being able to destroy a lock that IS.
 *
 * THE RACE THIS EXISTS TO KILL:
 *
 * The obvious steal — `rmSync(lockDir, {force: true})` then `mkdirSync` — is
 * not mutual exclusion at all. Two processes routinely reach a recovery path on
 * the same stale lock (the fast-checker's poll loop and any CLI invocation both
 * find it, and both finish their liveness/age check before either acts):
 *
 *   A: rmSync (clears the stale lock) -> mkdirSync -> writes pid=A -> HOLDS IT
 *   B: rmSync(force) -> DELETES A's LIVE LOCK -> mkdirSync now SUCCEEDS -> pid=B
 *
 * Both believe they hold it and enter the critical section together. Guarding
 * with EEXIST on `mkdirSync` cannot help, because the caller's own force-delete
 * destroyed the winner's lock one line earlier.
 *
 * The recovery path is precisely where this fires — which is the whole purpose
 * of the function. Code written to prevent silent message loss would cause it.
 *
 * `rename()` is atomic: exactly one process can move the directory aside. The
 * loser gets ENOENT and returns immediately, never reaching an `rmSync`, so it
 * cannot delete anyone's live lock.
 *
 * Exported for tests: the failure mode (capturing a lock that turns out to be
 * LIVE) is a nanosecond-wide interleaving that spawning real processes cannot
 * reliably reproduce, so it is asserted directly against this function.
 */
export function stealLock(lockDir: string, pidFile: string): boolean {
  // 1. EXCLUDE OTHER STEALERS.
  //
  //    You cannot judge an object safely unless nothing can change it under you.
  //    The way to get that is NOT to own the object — owning it means MOVING it,
  //    and a lock moved aside is ABSENT, which an ordinary acquirer's mkdirSync
  //    will happily succeed into. That is a second holder. Exclude the things
  //    that could change it instead, and judge it IN PLACE.
  const claim = `${lockDir}.stealing`;
  if (!acquireClaim(claim)) return false;

  try {
    // 2. RE-INSPECT UNDER THE CLAIM. The caller's staleness verdict came from an
    //    earlier stat and may already be stale: the rightful winner could have
    //    finished its own steal and installed a fresh, LIVE lock since.
    //
    //    Under the claim that cannot happen beneath us:
    //      - other stealers are excluded by the claim;
    //      - an ordinary acquirer only calls mkdirSync(lockDir), which EEXISTs
    //        while the lock is still present.
    //    So a lock observed abandoned while we hold the claim STAYS abandoned.
    const info = inspectLockDir(lockDir);
    if (!info) return false;              // already gone — the caller's mkdir will take it
    if (holderAlive(info)) return false;  // a live process holds it: leave it untouched
    if (info.pidUnreadable && info.ageMs < LOCK_STALE_MS) return false; // mid-acquire

    // Remember WHICH object we judged. The claim is age-recoverable (it must be —
    // a killed stealer would otherwise leak it forever and block all recovery),
    // so two stealers CAN hold it at once. Then this can happen:
    //
    //   A: judges abandoned -> steals -> installs a FRESH LIVE lock
    //   B: (verdict already recorded) renames lockDir aside — but lockDir is now
    //      A's LIVE lock, a DIFFERENT OBJECT than the one B judged.
    //
    // A verdict may only authorise destroying the object it actually examined.
    // The inode is that object's identity, and rename preserves it.
    const judgedIno = statSync(lockDir).ino;

    // 3. Move it aside with rename — ATOMIC, so exactly one process can be the
    //    mover; the loser gets ENOENT and touches nothing.
    const dead = `${lockDir}.dead.${process.pid}.${Date.now()}`;
    try {
      renameSync(lockDir, dead);
    } catch {
      return false; // someone else moved it first — nothing of ours destroyed
    }

    // IDENTITY CHECK: is what we captured the thing we judged?
    let capturedIno: bigint | number | undefined;
    try { capturedIno = statSync(dead).ino; } catch { capturedIno = undefined; }
    if (capturedIno !== judgedIno) {
      // We captured an object we never examined — it may be a live lock. Put it
      // back. A stale verdict must not be able to destroy what it never saw.
      try { renameSync(dead, lockDir); } catch { /* someone re-took the slot */ }
      return false;
    }

    try { rmSync(dead, { recursive: true, force: true }); } catch { /* inert */ }

    try {
      // Atomic. EEXIST means an ordinary acquirer took the freed slot ahead of
      // us — a legitimate loss, and nothing live was destroyed to discover it.
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return true;
    } catch {
      return false;
    }
  } finally {
    releaseClaim(claim);
  }
}

/**
 * Serialise stealers. `mkdir` is the atomic exclusive primitive.
 *
 * The claim must itself be recoverable: a process killed while holding it would
 * leak an empty directory that blocks EVERY future recovery — which is precisely
 * the permanent-deadlock disease this change exists to cure, relocated one level
 * up. The cure must not reintroduce the disease.
 *
 * Age is the only recovery signal available (the claim is deliberately empty, so
 * there is no PID to test), and an age-based break can in principle let two
 * stealers hold the claim at the same instant. That is survivable BY DESIGN:
 * stealLock's only destructive step is an atomic rename of a lock it has just
 * verified abandoned, so two claim-holders still cannot both win, and neither can
 * destroy a live lock. The claim reduces contention; it is not load-bearing for
 * correctness.
 */
function acquireClaim(claim: string): boolean {
  try {
    mkdirSync(claim);
    return true;
  } catch {
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(claim).mtimeMs;
    } catch {
      return false; // vanished — caller retries
    }
    if (ageMs < LOCK_STALE_MS) return false; // a stealer is genuinely working

    // Leaked by a killed stealer. rmdirSync removes only an EMPTY directory, so
    // it cannot destroy anything carrying state.
    try {
      rmdirSync(claim);
      mkdirSync(claim);
      return true;
    } catch {
      return false;
    }
  }
}

function releaseClaim(claim: string): void {
  try { rmdirSync(claim); } catch { /* already gone */ }
}

/** Is this lock held by a process that is actually running? */
function holderAlive(info: LockHeldInfo): boolean {
  if (info.pidUnreadable || info.pid === undefined) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false; // dead pid
  }
}

/**
 * Break a lock whose PID cannot be read, but only once it is older than
 * LOCK_STALE_MS — i.e. far past any legitimate mkdir→writeFileSync window, so
 * a live mid-acquire holder is never robbed.
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

  return stealLock(lockDir, pidFile);
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
