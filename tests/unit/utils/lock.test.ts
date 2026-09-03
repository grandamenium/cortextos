import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { acquireLock, releaseLock, withFileLockSync } from '../../../src/utils/lock';

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    // Same process, same PID - should fail since lock.d already exists
    // (but our PID check will see it's our own process and succeed)
    // Actually, mkdir will fail because it already exists, then we check PID
    // Since it's our own PID, it sees process alive and returns false
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });
});

describe('stale lock reclaim', () => {
  let testDir: string;
  let lockDir: string;
  let pidFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-stale-'));
    lockDir = join(testDir, '.lock.d');
    pidFile = join(lockDir, 'pid');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Backdate the lock dir's mtime so it reads as acquired `ms` ago. */
  function backdate(ms: number): void {
    const t = new Date(Date.now() - ms);
    utimesSync(lockDir, t, t);
  }

  it('does NOT reclaim a young lock with a missing pid file (holder mid-acquire)', () => {
    mkdirSync(lockDir);
    expect(acquireLock(testDir)).toBe(false);
  });

  it('does NOT reclaim a young lock with an empty pid file', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    expect(acquireLock(testDir)).toBe(false);
  });

  it('reclaims a stale lock with an empty pid file', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    backdate(10_000);
    expect(acquireLock(testDir, { staleMs: 1000 })).toBe(true);
    // We now genuinely hold it: pid file names us, re-acquire is refused.
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('reclaims a stale lock with a corrupt pid file', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, 'not-a-pid');
    backdate(10_000);
    expect(acquireLock(testDir, { staleMs: 1000 })).toBe(true);
    releaseLock(testDir);
  });

  it('reclaims a stale lock with a missing pid file', () => {
    mkdirSync(lockDir);
    backdate(10_000);
    expect(acquireLock(testDir, { staleMs: 1000 })).toBe(true);
    releaseLock(testDir);
  });

  it('reclaims a lock held by a dead process immediately (no age needed)', () => {
    // spawnSync has fully reaped the child by the time it returns, so its
    // pid is guaranteed dead (not a zombie).
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.pid).toBeGreaterThan(0);
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(dead.pid));
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('reclaims an alive-pid lock past the stale threshold (recycled/hung holder)', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    backdate(10_000);
    expect(acquireLock(testDir, { staleMs: 1000 })).toBe(true);
    releaseLock(testDir);
  });

  it('does NOT reclaim an alive-pid lock within the stale threshold', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    expect(acquireLock(testDir)).toBe(false);
  });

  it('leaves no tombstone behind after a reclaim', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    backdate(10_000);
    expect(acquireLock(testDir, { staleMs: 1000 })).toBe(true);
    releaseLock(testDir);
    expect(readdirSync(testDir).filter(f => f.includes('.stale-'))).toEqual([]);
  });
});

describe('withFileLockSync', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-wfls-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('runs fn under the lock and releases afterwards', () => {
    const result = withFileLockSync(testDir, () => {
      expect(existsSync(join(testDir, '.lock.d'))).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(join(testDir, '.lock.d'))).toBe(false);
  });

  it('acquires through a stale wedged lock instead of timing out', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '');
    const t = new Date(Date.now() - 10_000);
    utimesSync(lockDir, t, t);

    let ran = false;
    withFileLockSync(testDir, () => { ran = true; }, { staleLockMs: 1000, timeoutMs: 2000 });
    expect(ran).toBe(true);
  });

  it('throws when a live young lock is never released within timeoutMs', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(() =>
      withFileLockSync(testDir, () => {}, { timeoutMs: 150 }),
    ).toThrow(/failed to acquire lock/);
    releaseLock(testDir);
  });
});
