import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
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

  it('does not steal a fresh lock with a missing pid file', () => {
    mkdirSync(join(testDir, '.lock.d'));

    expect(acquireLock(testDir)).toBe(false);
  });

  it('self-heals an old lock with a missing pid file', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    makeOld(lockDir);

    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('self-heals an old lock with an empty pid file', () => {
    const lockDir = join(testDir, '.lock.d');
    const pidFile = join(lockDir, 'pid');
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    makeOld(pidFile);

    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('self-heals an old lock with a non-numeric pid file', () => {
    const lockDir = join(testDir, '.lock.d');
    const pidFile = join(lockDir, 'pid');
    mkdirSync(lockDir);
    writeFileSync(pidFile, 'not-a-pid');
    makeOld(pidFile);

    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    releaseLock(testDir);
  });
});

function makeOld(path: string): void {
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(path, old, old);
}
