import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, statSync } from 'fs';
import { join } from 'path';

/**
 * How long a lock directory may sit with NO pid file before we treat it as
 * abandoned.  The window between `mkdirSync` and `writeFileSync` in
 * `claimLock` is sub-millisecond, so 30s is ~30,000x the exposure: for this to
 * steal from a live holder, that holder must freeze *precisely* inside the gap,
 * stay frozen past the threshold, and then resume.
 */
const PIDLESS_STEAL_AFTER_MS = 30_000;

/**
 * How long a lock may be held by a PID we can see but cannot *identify* before
 * we treat it as abandoned (no /proc, or a legacy pid-only record).  Longer
 * than PIDLESS_STEAL_AFTER_MS because we have no corroborating evidence at all
 * here — only the passage of time.  Every caller holds this lock for a
 * synchronous JSON read-modify-write measured in milliseconds, so a five-minute
 * tenure is already pathological.
 */
const UNVERIFIABLE_STEAL_AFTER_MS = 300_000;

/**
 * Read a process's start time (field 22 of /proc/<pid>/stat, in clock ticks
 * since boot).  Together with the PID this forms an identity that survives PID
 * reuse: the OS can recycle the number, but not the number *and* the start
 * tick.
 *
 * Returns null when unavailable (non-Linux, or the process is gone), which
 * callers must treat as "cannot identify" — never as "dead".
 */
function readStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Field 2 (comm) is parenthesised and may itself contain spaces AND
    // parens — e.g. "((sd-pam))".  Split after the LAST ')', never by naive
    // whitespace splitting of the whole line.
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const start = stat.slice(close + 2).split(' ')[19];
    return start !== undefined && /^\d+$/.test(start) ? start : null;
  } catch {
    return null;
  }
}

/** The identity we stamp into the pid file: "<pid> <starttime>", or "<pid>". */
function ownerRecord(): string {
  const startTime = readStartTime(process.pid);
  return startTime === null ? String(process.pid) : `${process.pid} ${startTime}`;
}

type Verdict =
  | 'alive'         // holder provably exists and is provably the original owner
  | 'dead'          // holder provably gone (ESRCH, or the PID was recycled)
  | 'unverifiable'; // something answers to the PID but we cannot identify it

/**
 * Decide the fate of the recorded lock holder.
 *
 * The critical correctness rule: **only ESRCH proves death.**  EPERM means the
 * process exists and merely is not signalable by us (a different UID) —
 * treating it as dead lets a contender delete a live owner's lock so that both
 * enter the critical section.
 */
function holderVerdict(pid: number, recordedStart: string | null): Verdict {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unverifiable';
    // EPERM: alive, just not signalable by us.  Fall through to identity.
  }

  // Something answers to this PID.  Is it still *our* holder?
  if (recordedStart === null) return 'unverifiable'; // legacy pid-only record
  const currentStart = readStartTime(pid);
  if (currentStart === null) return 'unverifiable';  // no /proc to corroborate
  // A mismatch is positive proof that the original holder exited and the OS
  // reused the number — so this steal is *proven* safe, not a gamble.
  return currentStart === recordedStart ? 'alive' : 'dead';
}

/**
 * Age of the lock dir in ms; 0 if it vanished or the clock went backwards.
 *
 * Both terms are wall-clock, so a forward clock step (an NTP correction, a VM
 * resume) inflates every lock's apparent age and can bring a live lock over a
 * steal threshold early.  There is no monotonic equivalent for a file
 * timestamp, so this is inherent to age-based recovery rather than a bug to
 * fix here — it is bounded by the loud log on every steal, and by the
 * thresholds being far longer than any real critical section.  Note this is
 * why the *timeout* in `withFileLockSync` uses hrtime instead: that one has a
 * monotonic option, and this one does not.
 */
function lockAgeMs(lockDir: string): number {
  try {
    return Math.max(0, Date.now() - statSync(lockDir).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * The exact record we wrote for each lock this process currently holds, keyed
 * by lock directory.
 *
 * `releaseLock` compares against THIS, not against a freshly computed
 * `ownerRecord()`.  Recomputing is not idempotent: `readStartTime` can fail
 * transiently (fd exhaustion, a /proc hiccup), and a claim-time record of
 * "<pid> <start>" then compares unequal to a release-time record of "<pid>",
 * so a process refuses to release its own intact lock — permanently, because
 * the holder it declines to remove is itself, and a live holder is judged
 * 'alive' forever by `holderVerdict` (no age threshold is ever consulted).
 * The record we actually wrote is ground truth; nothing else is.
 */
const heldRecords = new Map<string, string>();

/**
 * Take exclusive custody of `lockDir` by renaming it aside, then delete it only
 * if what is inside satisfies `accept`.
 *
 * This is the same pattern `stealLock` implements inline, and it exists for the
 * same reason: a verdict about a lock is a statement about the record we
 * *read*, but a delete-by-pathname acts on whatever occupies the path *now*.
 * Between those two moments the lock can turn over, and an unguarded delete
 * then removes a live holder's directory — the exact silent cascade the
 * ownership check in `releaseLock` was added to prevent, reintroduced by the
 * very next statement.  `renameSync` is atomic, so exactly one contender wins
 * the right to remove the directory; the contents are then re-read under the
 * temporary name, where nobody else can reach them, which is what makes the
 * second look authoritative rather than another guess.
 *
 * A useful consequence: the rename IS the release.  Once it succeeds the
 * canonical path is free and the lock is acquirable again, so a later `rmSync`
 * failure leaks a temp directory rather than wedging the lock.
 *
 * RESIDUAL, stated rather than glossed — identical to the one in `stealLock`,
 * and not closable from here: between the rename and a declining restore the
 * canonical path is vacant, so a third acquirer can `mkdirSync` it.  If it has
 * already written its pid, the restore fails with ENOTEMPTY; if it is still
 * inside its sub-millisecond mkdir-to-pid-write window, rename onto an empty
 * directory SUCCEEDS on Linux and silently replaces it.  Node exposes no
 * RENAME_NOREPLACE, so there is no atomic "restore only if absent" available.
 * Both outcomes now log — see `declined` below.
 */
/**
 * `lost` is split because the two failures mean OPPOSITE things about whether we
 * still hold the lock, and `releaseLock` has to act differently on each.
 *
 *   - `vanished` (ENOENT): the directory is not there.  We no longer hold it,
 *     and the path is free for anyone — including us — to acquire again.
 *   - `stuck` (any other errno): the directory is still sitting there, still
 *     carrying our record.  We DO still hold it, and nothing but this process
 *     can free it: every future acquirer will judge the holder alive.
 *
 * Collapsing these into one outcome is what makes "just forget the record on a
 * failed release" wrong — see `releaseLock`.
 */
type Custody = 'removed' | 'declined' | 'vanished' | 'stuck';

function removeWithCustody(
  lockDir: string,
  accept: (actual: string | null) => boolean,
  describe: (actual: string | null) => string,
): Custody {
  const tmp = `${lockDir}.release.${process.pid}.${process.hrtime.bigint()}`;
  try {
    renameSync(lockDir, tmp);
  } catch (err) {
    // ENOENT means the directory is simply not there any more — our lock was
    // removed under us.  Anything else (EACCES, EIO, EBUSY) means the lock is
    // still sitting there and we could not free it, which wedges every future
    // acquirer for as long as this process lives.  Neither may be swallowed:
    // callers that fail to acquire a lock frequently degrade to a silent no-op
    // (checkInbox returns an empty list), so a wedged lock reads as "nothing to
    // do" rather than as an outage.
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === 'ENOENT'
        ? `[lock] lock "${lockDir}" was already gone when we tried to release it — ` +
          `it was stolen or removed while we were inside the critical section; ` +
          `data guarded by it may be torn. Investigate.`
        : `[lock] FAILED to release "${lockDir}" (${code ?? 'unknown error'}). ` +
          `The lock directory is still present and this process is still alive, so ` +
          `every future acquirer will judge it 'alive' and block indefinitely. Investigate.`,
    );
    return code === 'ENOENT' ? 'vanished' : 'stuck';
  }

  let actual: string | null;
  try {
    actual = readFileSync(join(tmp, 'pid'), 'utf-8').trim();
  } catch {
    // Cannot distinguish "no pid file" from a transient read failure here, and
    // the safe direction is to decline: putting a lock back is recoverable,
    // deleting someone else's is not.
    actual = null;
  }

  if (!accept(actual)) {
    try {
      renameSync(tmp, lockDir);
      // Logged even when the restore SUCCEEDS: success here does not mean no
      // harm was done.  The restore can land on a third acquirer's empty
      // directory (see RESIDUAL above), which destroys its claim while it still
      // believes it holds the lock.  That case is invisible from this side, so
      // the window being entered at all is the only thing we can report.
      console.error(
        `[lock] declined to remove "${lockDir}": ${describe(actual)}. Restored it.`,
      );
    } catch {
      console.error(
        `[lock] could not restore "${lockDir}" after declining to remove it ` +
        `(${describe(actual)}). A live holder may have lost its lock directory — investigate.`,
      );
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
    return 'declined';
  }

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // The rename already freed the lock path, so the lock is released; this
    // only leaks a temp directory. Not worth failing the release over.
  }
  return 'removed';
}

/**
 * mkdir the lock dir and stamp our identity into it.
 *
 * If the mkdir succeeds but the pid write does not, the directory MUST be
 * removed before the error propagates — otherwise it leaks as a lock nobody
 * holds and nobody can attribute, wedging every future acquirer.
 *
 * That cleanup goes through `removeWithCustody` for the reason spelled out
 * there.  A plain `rmSync(lockDir)` here is unsafe: if our pid write fails
 * slowly — or we freeze between the mkdir and the throw — the pidless directory
 * we left behind is exactly what `acquireLock` steals after
 * PIDLESS_STEAL_AFTER_MS, so by the time we run the cleanup the path can name a
 * *different, live* lock, and removing it by pathname deletes a holder that has
 * done nothing wrong.
 *
 * We accept only a directory with NO pid file, because that is the state we
 * left ours in — we are here precisely because the write did not succeed.  A
 * partially written record therefore reads as "not ours" and is left alone; the
 * corrupt-record path in `acquireLock` recovers it after PIDLESS_STEAL_AFTER_MS.
 * Leaving a lock behind is recoverable; deleting a live one is not.
 */
function claimLock(lockDir: string, pidFile: string): boolean {
  mkdirSync(lockDir); // throws EEXIST to the caller if someone beat us to it
  const record = ownerRecord();
  try {
    writeFileSync(pidFile, record);
  } catch (err) {
    removeWithCustody(
      lockDir,
      actual => actual === null,
      actual =>
        `our pid write failed, but the directory now holds "${actual}" — ` +
        `it is no longer the one we created`,
    );
    throw err;
  }
  heldRecords.set(lockDir, record);
  return true;
}

/**
 * Remove a lock we have judged abandoned and take it, atomically.
 *
 * The naive steal (rmSync then mkdirSync) is itself a mutual-exclusion bug: two
 * contenders can interleave as rm(A), mkdir(A), rm(B) — which deletes A's fresh
 * directory — then mkdir(B), leaving BOTH believing they hold the lock.
 * `renameSync` is atomic, so exactly one contender wins the right to remove it.
 *
 * But atomic removal is NOT enough on its own.  The staleness verdict is about
 * the record we *read*; the rename acts on whatever occupies the path *now*:
 *
 *   - A and B both read holder X and both correctly judge it dead.
 *   - A renames X away, removes it, and claims a fresh lock.  A legitimately holds it.
 *   - B's rename now runs.  The path exists again — it is A's LIVE lock — so B's
 *     rename SUCCEEDS, and B steals a lock it never examined.  Both proceed.
 *
 * So the rename is only the first half: it wins us exclusive custody of the
 * directory, and `expected` is then re-checked *inside* that custody.  Nobody
 * else can reach the dir under its new name, so what we read there is
 * authoritative.  Mismatch means the lock turned over between our verdict and
 * our rename — we put it back and lose the race rather than steal a live lock.
 *
 * `expected` is the exact trimmed pid-file content the verdict was based on, or
 * null when the verdict was "there is no readable pid file".
 */
function stealLock(
  lockDir: string,
  pidFile: string,
  expected: string | null,
  reason: string,
): boolean {
  const tmp = `${lockDir}.stale.${process.pid}.${process.hrtime.bigint()}`;
  try {
    renameSync(lockDir, tmp);
  } catch {
    return false; // another contender got there first — let the caller retry
  }

  // Exclusive custody: re-read under the new name and confirm this is the same
  // lock we judged, not a live one that replaced it.
  let actual: string | null;
  try {
    actual = readFileSync(join(tmp, 'pid'), 'utf-8').trim();
  } catch {
    actual = null;
  }
  if (actual !== expected) {
    try {
      // Put it back; the holder we renamed aside is unharmed.
      //
      // RESIDUAL, stated rather than glossed: rename onto an existing EMPTY
      // directory SUCCEEDS on Linux (verified — a non-empty target gives
      // ENOTEMPTY). So if a third acquirer is inside its own sub-millisecond
      // mkdir-to-pid-write window right now, this replaces its fresh dir. It
      // then writes its pid into the restored one and holds the lock, while the
      // holder we restored believes it still does. Node exposes no
      // RENAME_NOREPLACE, so there is no atomic "rename only if absent" to use
      // instead.
      //
      // An earlier version of this comment called ownership-checked releaseLock
      // "the backstop that check exists for". That overstated it, and the
      // correction matters more than the original claim did. Ownership-checked
      // release does two things: it stops the loser from deleting the winner's
      // live lock on its way out, and it reports the loss. It does NOT prevent
      // the two of them from being inside the critical section at the same time
      // — that violation happens, completes, and can tear the guarded data
      // BEFORE either party reaches a release. "Not silent" is therefore true
      // only after the fact; while the window is open it is entirely silent.
      // The residual is bounded and eventually observable, not neutralised.
      renameSync(tmp, lockDir);
      // Logged on SUCCESS too: a successful restore is not evidence of no harm,
      // because the empty-directory case above is invisible from this side.
      console.error(
        `[lock] aborted a steal of "${lockDir}": holder changed from ` +
        `${expected ?? '<no pid file>'} to ${actual ?? '<no pid file>'} before we could ` +
        `take it. Restored it; a third acquirer racing this window may have lost its claim.`,
      );
    } catch {
      // We could not restore it — a new acquirer already occupies the path, so
      // some other holder's lock directory is now gone. This is the one hole we
      // cannot close from here; ownership-checked releaseLock is its backstop.
      console.error(
        `[lock] could not restore lock "${lockDir}" after aborting a steal ` +
        `(holder changed from ${expected ?? '<no pid file>'} to ${actual ?? '<no pid file>'}). ` +
        `A live holder may have lost its lock directory — investigate.`,
      );
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
    return false;
  }

  // We removed a lock on the strength of an inference, not a certainty. Say so
  // loudly: if the rare bad case ever happens (a holder resuming after we
  // judged it abandoned) this line is the only thing that makes it visible.
  console.error(
    `[lock] STOLE apparently-stale lock "${lockDir}" (${reason}). ` +
    `If a live holder was still using it, this is a mutual-exclusion violation — investigate.`,
  );

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best effort — the rename already freed the lock path.
  }

  try {
    return claimLock(lockDir, pidFile);
  } catch (err) {
    // A brand-new acquirer legitimately beat us to the freed path.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Recovers abandoned locks — see `holderVerdict` for how "abandoned" is decided,
 * and the module constants for the thresholds used where it cannot be proven.
 */
export function acquireLock(dir: string): boolean {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');

  try {
    return claimLock(lockDir, pidFile);
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
    // 12).  When the PID file is missing the holder is mid-acquire and the
    // caller should retry — until the directory is old enough that no
    // mid-acquire explanation is credible any more.
    let storedRaw: string;
    try {
      storedRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      const age = lockAgeMs(lockDir);
      if (age >= PIDLESS_STEAL_AFTER_MS) {
        return stealLock(
          lockDir, pidFile, null,
          `no pid file after ${Math.round(age / 1000)}s — holder died between mkdir and pid write`,
        );
      }
      return false;
    }

    // Parse the WHOLE record with an anchored pattern.  A bare parseInt would
    // accept "123abc" as pid 123 and half-parse partial corruption into a
    // valid-looking identity; here anything we did not write is simply corrupt.
    const parsed = /^(\d+)(?: (\d+))?$/.exec(storedRaw);
    const storedPid = parsed ? parseInt(parsed[1], 10) : NaN;
    // Reject non-positive PIDs explicitly: process.kill(0, 0) signals our OWN
    // process group and would succeed, making a corrupt "0" pid file read as a
    // permanently live holder.  Negative values address a process group too.
    if (isNaN(storedPid) || storedPid <= 0) {
      // Corrupt PID file.  Don't steal on sight — let the caller retry, and let
      // the age threshold recover it if it never becomes readable.
      const age = lockAgeMs(lockDir);
      if (age >= PIDLESS_STEAL_AFTER_MS) {
        return stealLock(
          lockDir, pidFile, storedRaw,
          `unusable pid record "${storedRaw}" after ${Math.round(age / 1000)}s`,
        );
      }
      return false;
    }

    const recordedStart = parsed![2] ?? null;

    switch (holderVerdict(storedPid, recordedStart)) {
      case 'dead':
        return stealLock(lockDir, pidFile, storedRaw, `holder pid ${storedPid} is gone`);
      case 'unverifiable': {
        const age = lockAgeMs(lockDir);
        if (age >= UNVERIFIABLE_STEAL_AFTER_MS) {
          return stealLock(
            lockDir, pidFile, storedRaw,
            `pid ${storedPid} answers but cannot be identified as the original holder ` +
            `(no /proc corroboration) and the lock is ${Math.round(age / 1000)}s old`,
          );
        }
        return false;
      }
      default:
        return false; // 'alive' — genuinely held
    }
  }
}

/**
 * Release a mutex lock — but only if it is still OURS.
 *
 * An unconditional remove here turns a single accepted steal into an unbounded
 * silent cascade.  Because a lock may be stolen from a holder that was merely
 * frozen (see the age thresholds above), that holder can wake up and finish:
 *
 *   1. A freezes past the threshold.  B steals — loudly, as designed.
 *   2. A resumes, completes, and releases — deleting B's lock while B is still
 *      inside its critical section.
 *   3. C now acquires cleanly.  B and C overlap, with no steal and no log
 *      anywhere: the loud line in `stealLock` never fires for step 3.
 *
 * So the steal is visible but the damage it seeds is not.  Checking ownership
 * before removing bounds the blast radius at the one overlap we knowingly
 * accepted, and converts every later one into a logged event instead of
 * silence.
 *
 * The check alone is NOT sufficient, and getting this wrong once already is why
 * the note is here.  Reading the record, deciding, and then removing by
 * pathname is a check-then-act race: the lock can be stolen from us in the gap
 * (the same freeze that got us stolen from in step 1 can recur), and `rmSync`
 * with `force` would then delete the *new* holder's live directory — recreating
 * exactly the cascade above, one statement below the check meant to stop it.
 * So the removal goes through `removeWithCustody`, which re-checks under a name
 * only we can reach.
 *
 * Failing to remove is the safe direction, but it is NOT free, and the earlier
 * claim here that "the age thresholds recover it" was wrong: those thresholds
 * are only consulted for pidless, corrupt, or unidentifiable records.  A lock
 * left holding the record of *this* live process is judged 'alive' on every
 * future acquisition and is never recovered while we run.  That is why every
 * path out of `removeWithCustody` that does not remove the lock logs.
 */
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');

  // The record we WROTE, not one recomputed now — see `heldRecords`.  No entry
  // means we do not hold this lock, and the only correct action on a lock we do
  // not hold is NOTHING.  The previous `?? ownerRecord()` fallback made a stray
  // release take custody of a healthy foreign lock — renaming it aside, reading
  // it, and renaming it back — which enters the restore window documented on
  // `removeWithCustody` (where it can destroy a third acquirer's fresh claim)
  // and logs "our lock was stolen ... data may be torn. Investigate", sending
  // someone after an incident that never happened.  Recomputing was never even
  // sound as identity: `readStartTime` can fail transiently, so the recomputed
  // record can differ from the one we wrote.
  const mine = heldRecords.get(lockDir);
  if (mine === undefined) {
    return;
  }

  const result = removeWithCustody(
    lockDir,
    actual => actual === mine,
    actual =>
      `it is held by ${actual ?? '<no pid file>'}, not us (${mine}); our lock was ` +
      `stolen or removed while we were still inside the critical section, so data ` +
      `guarded by it may be torn`,
  );

  // The entry must mean "we hold this ACQUISITION", but the record identifies a
  // PROCESS — there is no generation nonce, and adding one is a format migration
  // (the record is parsed by a fixed regex further down).  So a surviving entry
  // is not inert: this process can re-acquire the same path later and write a
  // byte-identical record, and a delayed or duplicated release would then match
  // on it and remove an acquisition it never owned.  Classic ABA.  Clearing the
  // entry the moment the acquisition ends is what keeps that unreachable
  // without the migration.
  //
  // `stuck` is the one outcome that must KEEP it: there the directory is still
  // present and still ours, so we are still the holder, and the entry is the
  // only surviving copy of the record needed to release it.  Dropping it would
  // turn every later release attempt into the no-op above and wedge the lock
  // permanently — the exact outcome the entry exists to prevent.  There is no
  // ABA risk in that state either: nobody, including us, can re-acquire a path
  // whose live holder is this process.
  if (result !== 'stuck') {
    heldRecords.delete(lockDir);
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
 * `fn` MUST be synchronous. This is a synchronous mutex: anything deferred past
 * `fn`'s return (an await, a callback, a Promise) runs with the lock ALREADY
 * RELEASED by the `finally` below.
 *
 * Stated property, so it is not a surprise in an incident: the recovery
 * thresholds are deliberately much longer than this timeout. A lock left in an
 * unprovable state therefore makes callers throw here — loudly, for up to
 * PIDLESS_STEAL_AFTER_MS (or UNVERIFIABLE_STEAL_AFTER_MS) — before anyone is
 * allowed to recover it. That is the intended order: fail visibly first, steal
 * only once no benign explanation survives.
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
