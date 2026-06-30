import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, withFileLockSync, sweepOrphanLockTemps } from '../../../src/utils/lock';

// A pid that is (essentially) guaranteed not to be a live process, so the
// liveness check (process.kill(pid, 0)) throws and the holder reads as dead.
const DEAD_PID = 2147483647;

describe('atomic file-based locking (.lock, windowless acquire)', () => {
  let testDir: string;
  const lockFile = () => join(testDir, '.lock');

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires on an empty dir; .lock exists holding our pid; no orphan temp', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(existsSync(lockFile())).toBe(true);
    // windowless invariant: the lock file ALWAYS carries the owner pid.
    expect(readFileSync(lockFile(), 'utf-8').trim()).toBe(String(process.pid));
    // the temp used to link the lock is cleaned up (no .lock.<pid>.<seq>.tmp left).
    expect(readdirSync(testDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    releaseLock(testDir);
  });

  it('prevents double acquire while a LIVE holder owns it (our own live pid)', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(acquireLock(testDir)).toBe(false); // our pid is alive → not stolen
    releaseLock(testDir);
  });

  it('releases and reacquires', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('recovers a DEAD-pid lock (crash-while-holding): first call clears, retry acquires', () => {
    writeFileSync(lockFile(), String(DEAD_PID)); // simulate a holder that crashed
    expect(acquireLock(testDir)).toBe(false);    // detects dead → removes (caller retries)
    expect(existsSync(lockFile())).toBe(false);  // stale lock cleared
    expect(acquireLock(testDir)).toBe(true);     // retry re-links cleanly
    expect(readFileSync(lockFile(), 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('recovers a CORRUPT lock (non-numeric content)', () => {
    writeFileSync(lockFile(), 'not-a-pid');
    expect(acquireLock(testDir)).toBe(false);    // corrupt → recoverable, removed
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('recovers an EMPTY lock (pid-less leftover — the bug class, now self-healing)', () => {
    writeFileSync(lockFile(), '');               // a pid-less lock would have deadlocked the old mutex
    expect(acquireLock(testDir)).toBe(false);    // empty → recoverable, removed
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireLock(testDir)).toBe(true);     // NOT a permanent deadlock anymore
    releaseLock(testDir);
  });

  describe('withFileLockSync', () => {
    it('runs fn under the lock and releases after', () => {
      let ran = false;
      withFileLockSync(testDir, () => { ran = true; });
      expect(ran).toBe(true);
      expect(existsSync(lockFile())).toBe(false); // released
      expect(acquireLock(testDir)).toBe(true);    // free again
      releaseLock(testDir);
    });

    it('releases the lock even if fn throws', () => {
      expect(() => withFileLockSync(testDir, () => { throw new Error('boom'); })).toThrow('boom');
      expect(existsSync(lockFile())).toBe(false); // released on throw
      expect(acquireLock(testDir)).toBe(true);
      releaseLock(testDir);
    });

    it('serializes: a live foreign holder blocks until released, then succeeds', () => {
      // Simulate a live foreign holder by linking a lock that names OUR (alive) pid.
      writeFileSync(lockFile(), String(process.pid));
      // withFileLockSync should time out fast against a live holder.
      expect(() => withFileLockSync(testDir, () => { /* unreachable */ }, { timeoutMs: 60 }))
        .toThrow(/failed to acquire/);
      // After release, it acquires + runs.
      releaseLock(testDir);
      let ran = false;
      withFileLockSync(testDir, () => { ran = true; });
      expect(ran).toBe(true);
    });
  });

  // ── identity-safe release (fast-follow clean win) ────────────────────────
  describe('identity-safe release', () => {
    it('releaseLock is identity-safe: never removes a lock owned by another pid', () => {
      writeFileSync(lockFile(), String(DEAD_PID)); // a FOREIGN owner's lock
      releaseLock(testDir);                         // we do NOT own it
      expect(existsSync(lockFile())).toBe(true);    // left intact — not ours to release
      // but our OWN lock IS released
      rmSync(lockFile(), { force: true });
      expect(acquireLock(testDir)).toBe(true);
      releaseLock(testDir);
      expect(existsSync(lockFile())).toBe(false);
    });

    it('recovering a dead lock clears it and leaves no .tmp residue', () => {
      writeFileSync(lockFile(), String(DEAD_PID));
      acquireLock(testDir);                          // dead → best-effort rmSync
      expect(existsSync(lockFile())).toBe(false);    // dead lock cleared
      expect(readdirSync(testDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });
  });

  // ── orphan temp sweep (fast-follow) ──────────────────────────────────────
  describe('sweepOrphanLockTemps (age + dead-owner gated)', () => {
    const tmpName = (pid: number) => `.lock.${pid}.${'a'.repeat(8)}-0000-0000-0000-000000000000.tmp`;
    const OLD = (Date.now() - 10 * 60_000) / 1000; // 10 min ago

    it('sweeps an OLD dead-owner temp, but NOT a live-owner or a FRESH temp', () => {
      const deadOld = join(testDir, tmpName(DEAD_PID));
      const liveOld = join(testDir, tmpName(process.pid));
      const deadFresh = join(testDir, `.lock.${DEAD_PID}.bbbbbbbb-0000-0000-0000-000000000000.tmp`);
      writeFileSync(deadOld, String(DEAD_PID)); utimesSync(deadOld, OLD, OLD);
      writeFileSync(liveOld, String(process.pid)); utimesSync(liveOld, OLD, OLD);
      writeFileSync(deadFresh, String(DEAD_PID)); // mtime = now

      const swept = sweepOrphanLockTemps(testDir, 5 * 60_000);
      expect(swept).toBe(1);                       // only the old dead-owner temp
      expect(existsSync(deadOld)).toBe(false);     // swept
      expect(existsSync(liveOld)).toBe(true);      // live owner — kept
      expect(existsSync(deadFresh)).toBe(true);    // too fresh — kept
    });

    it('ignores non-lock files and the live .lock itself', () => {
      acquireLock(testDir);                         // creates a live .lock
      writeFileSync(join(testDir, 'message.json'), '{}');
      const swept = sweepOrphanLockTemps(testDir, 0); // age 0 = sweep any old-enough
      expect(swept).toBe(0);                         // .lock isn't a .tmp; message.json isn't a lock temp
      expect(existsSync(lockFile())).toBe(true);
      expect(existsSync(join(testDir, 'message.json'))).toBe(true);
      releaseLock(testDir);
    });
  });
});
