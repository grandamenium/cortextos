import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stealLock, LOCK_STALE_MS } from '../../../src/utils/lock';

/**
 * MUTUAL EXCLUSION UNDER CONCURRENT RECOVERY.
 *
 * The naive steal — `rmSync(lockDir, {force:true})` then `mkdirSync` — is not
 * mutual exclusion. Two processes routinely reach the recovery path on the same
 * stale lock (the fast-checker's poll loop and any CLI invocation both find it,
 * and both finish their staleness check before either acts):
 *
 *   A: rmSync (clears the stale lock) -> mkdirSync -> pid=A -> HOLDS IT
 *   B: rmSync(force) -> DELETES A's LIVE LOCK -> mkdirSync succeeds -> pid=B
 *
 * Both then enter the critical section together — duplicate delivery, lost ACKs,
 * a message file removed while another process reads it. The bug fires on the
 * code path whose entire job is to recover safely.
 *
 * WHY THESE TESTS CALL stealLock DIRECTLY RATHER THAN RACING PROCESSES:
 * the damaging interleaving is nanoseconds wide. Spawning real processes cannot
 * hit it — they start milliseconds apart, so the first one wins cleanly and the
 * rest correctly see a live PID. A spawn-based "race" test PASSES against the
 * buggy code and proves nothing. (I wrote one first. It was theatre.)
 *
 * So the invariant is asserted where it actually lives: given a stealer that has
 * CAPTURED a lock which turns out to be LIVE — exactly the state B lands in — it
 * must refuse and put it back, rather than destroy it and claim the lock.
 */
describe('stealLock: cannot take a lock that is actually held', () => {
  let dir: string;
  let lockDir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-steal-'));
    lockDir = join(dir, '.lock.d');
    pidFile = join(lockDir, 'pid');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES a lock held by a LIVE pid, and leaves it intact', () => {
    // This is precisely what B captures when A wins the race and creates a new
    // live lock in the window between B's staleness check and B's capture.
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid)); // alive: us

    expect(stealLock(lockDir, pidFile)).toBe(false);

    // The live holder's lock must survive untouched — not be destroyed and
    // replaced with ours, which is what the rmSync(force) version did.
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
  });

  it('REFUSES a lock whose holder is mid-acquire (no pid yet, but fresh)', () => {
    // The mkdir→writeFileSync window. Young + unreadable pid = someone is in it.
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');

    expect(stealLock(lockDir, pidFile)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('TAKES a genuinely abandoned lock (old, pid never written)', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    const old = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    utimesSync(lockDir, old, old);

    expect(stealLock(lockDir, pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
  });

  it('TAKES a lock held by a dead pid', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '4194304'); // above pid_max — never alive

    expect(stealLock(lockDir, pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
  });

  it('leaves no orphaned scratch or claim directories behind, win or lose', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid)); // live -> stealLock must lose
    stealLock(lockDir, pidFile);
    expect(readdirSync(dir).filter((f) => f !== '.lock.d')).toEqual([]);

    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(pidFile, '4194304'); // dead -> stealLock must win
    stealLock(lockDir, pidFile);
    expect(readdirSync(dir).filter((f) => f !== '.lock.d')).toEqual([]);
  });

  /**
   * THE INVARIANT THAT KILLS THE THIRD-PROCESS RACE — and an honest note on how
   * far a test can go here.
   *
   * Any implementation that renames a live lock ASIDE (to inspect it, meaning to
   * put it back) leaves lockDir ABSENT for a moment. An ordinary acquirer only
   * calls mkdirSync(lockDir), which SUCCEEDS on an absent dir — so a third
   * process walks straight in, and the restore then either fails (and the live
   * lock is discarded) or succeeds (and clobbers the newcomer). Either way: two
   * holders. So a live lock must never be MOVED AT ALL.
   *
   * That invariant is enforced STRUCTURALLY: stealLock renames only after it has
   * verified, while holding the claim, that the lock is abandoned — and under the
   * claim nothing can make it live again (other stealers are excluded; ordinary
   * acquirers EEXIST while the lock is present). There is no code path on which a
   * live lock is moved, so none on which one must be restored.
   *
   * I could not write a SOUND unit test for "was it moved". The obvious probe —
   * compare the lock's ctime — is real, but ctime is MILLISECOND-granular on this
   * filesystem: a rename-aside-and-back inside one tick leaves it unchanged, so
   * the test goes red in isolation and GREEN in a warm run. A test that catches
   * the bug only sometimes is decoration with extra steps, and it is not shipped.
   * What is asserted instead is the deterministic consequence.
   */
  it('leaves a live holder\'s lock exactly as it found it', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));

    expect(stealLock(lockDir, pidFile)).toBe(false);

    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    // No scratch left from a capture that should never have happened.
    expect(readdirSync(dir).filter((f) => f !== '.lock.d')).toEqual([]);
  });
});

/**
 * The cure must not reintroduce the disease.
 *
 * Serialising stealers behind a claim directory is only safe if the CLAIM is
 * itself recoverable. A process killed while holding it leaks an empty dir that
 * would block EVERY future recovery, for the life of the machine — which is
 * exactly the permanent deadlock we set out to fix, moved up one level.
 */
describe('stealLock: a leaked claim cannot deadlock recovery forever', () => {
  let dir: string;
  let lockDir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-claim-'));
    lockDir = join(dir, '.lock.d');
    pidFile = join(lockDir, 'pid');
    // An abandoned lock, waiting to be recovered.
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    const old = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    utimesSync(lockDir, old, old);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers when a killed stealer leaked its claim', () => {
    const claim = `${lockDir}.stealing`;
    mkdirSync(claim);
    const old = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    utimesSync(claim, old, old); // leaked long ago by a dead stealer

    // Must NOT be blocked forever by the orphaned claim.
    expect(stealLock(lockDir, pidFile)).toBe(true);
    expect(existsSync(claim)).toBe(false); // and it cleans up after itself
  });

  it('DEFERS to a stealer that is genuinely working (fresh claim)', () => {
    const claim = `${lockDir}.stealing`;
    mkdirSync(claim); // someone is mid-steal right now

    expect(stealLock(lockDir, pidFile)).toBe(false);
    expect(existsSync(claim)).toBe(true); // and we did not stomp their claim
  });
});
