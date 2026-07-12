import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync, readFileSync } from 'fs';
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

  it('leaves no orphaned steal scratch directories behind, win or lose', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid)); // live -> stealLock must lose
    stealLock(lockDir, pidFile);
    expect(readdirSync(dir).filter((f) => f.startsWith('.lock.d.steal'))).toEqual([]);

    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(pidFile, '4194304'); // dead -> stealLock must win
    stealLock(lockDir, pidFile);
    expect(readdirSync(dir).filter((f) => f.startsWith('.lock.d.steal'))).toEqual([]);
  });
});
