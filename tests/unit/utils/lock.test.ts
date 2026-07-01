import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../../../src/utils/lock';

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

describe('stale-lock recovery (orphaned .lock.d)', () => {
  let testDir: string;
  const lockDir = () => join(testDir, '.lock.d');
  const pidFile = () => join(lockDir(), 'pid');

  // Backdate .lock.d far past any sane staleness threshold. The real
  // mkdir→writeFile mid-acquire gap is microseconds; 10 minutes is stale
  // by any policy. Tests only assume the threshold is between ~2s and 10min.
  const backdate = (ms: number) => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(lockDir(), t, t);
  };
  const TEN_MINUTES = 10 * 60 * 1000;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('steals an old lock whose pid file is missing (holder died mid-acquire)', () => {
    mkdirSync(lockDir());
    backdate(TEN_MINUTES);
    expect(acquireLock(testDir)).toBe(true);
    // We now hold it: pid file records this process
    expect(readFileSync(pidFile(), 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('steals an old lock whose pid file is empty (holder died mid-write)', () => {
    mkdirSync(lockDir());
    writeFileSync(pidFile(), '');
    backdate(TEN_MINUTES);
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile(), 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('steals an old lock whose pid file is corrupt (non-numeric)', () => {
    mkdirSync(lockDir());
    writeFileSync(pidFile(), 'not-a-pid');
    backdate(TEN_MINUTES);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('does NOT steal a fresh lock with missing pid file (holder mid-acquire)', () => {
    mkdirSync(lockDir());
    // No backdate: mtime is now — the mkdir/writeFile gap must stay protected
    expect(acquireLock(testDir)).toBe(false);
  });

  it('does NOT steal a fresh lock with empty pid file', () => {
    mkdirSync(lockDir());
    writeFileSync(pidFile(), '');
    expect(acquireLock(testDir)).toBe(false);
  });

  it('does NOT steal an old lock held by a live process', () => {
    mkdirSync(lockDir());
    writeFileSync(pidFile(), String(process.pid));
    backdate(TEN_MINUTES);
    // Live holder: age alone must never override a valid live pid
    expect(acquireLock(testDir)).toBe(false);
  });

  it('still steals a lock with a valid pid of a dead process (existing behavior)', () => {
    const dead = spawnSync('true');
    expect(dead.pid).toBeGreaterThan(0);
    mkdirSync(lockDir());
    writeFileSync(pidFile(), String(dead.pid));
    // No backdate needed: dead-pid detection is age-independent
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });
});
