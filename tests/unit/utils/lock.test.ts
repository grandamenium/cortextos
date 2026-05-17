import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
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

  it('recovers stale empty .lock.d/ after grace period', () => {
    // Create empty .lock.d/ with old mtime (>30s old)
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const oldTime = Date.now() - 31000; // 31s ago
    utimesSync(lockDir, oldTime / 1000, oldTime / 1000);

    // Should steal the stale lock
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('does not steal fresh empty .lock.d/ within grace period', () => {
    // Create empty .lock.d/ with recent mtime (<5s old)
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const recentTime = Date.now() - 5000; // 5s ago
    utimesSync(lockDir, recentTime / 1000, recentTime / 1000);

    // Should refuse the lock (assume mid-acquire)
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('still blocks when process holds lock with valid pid', () => {
    // Acquire lock first
    expect(acquireLock(testDir)).toBe(true);

    // Try to acquire again (same process)
    expect(acquireLock(testDir)).toBe(false);

    releaseLock(testDir);
  });
});
