import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, inspectLock, LOCK_STALE_MS } from '../../../src/utils/lock';

/** Forge a lock dir exactly as a process killed mid-acquire leaves it, aged `ageMs` into the past. */
function forgeLock(dir: string, pidContent: string | null, ageMs: number): void {
  const lockDir = join(dir, '.lock.d');
  mkdirSync(lockDir);
  if (pidContent !== null) writeFileSync(join(lockDir, 'pid'), pidContent);
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockDir, when, when);
}

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

/**
 * Regression: an agent's inbox lock was left behind by a hard shutdown (the
 * process was killed between mkdirSync and writeFileSync, leaving an EMPTY pid
 * file). With no PID to liveness-check, the old code refused the lock forever —
 * check-inbox returned [] for three days while 26 messages queued behind it.
 *
 * The empty/absent PID cases are the crash window. They must self-heal on age.
 */
describe('abandoned-lock recovery (crash between mkdir and pid write)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-stale-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('breaks an OLD lock with an EMPTY pid file (the exact production deadlock)', () => {
    forgeLock(testDir, '', LOCK_STALE_MS + 60_000);
    expect(acquireLock(testDir)).toBe(true);
    // and we now own it — our pid was written
    expect(readFileSync(join(testDir, '.lock.d', 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('breaks an OLD lock with NO pid file at all', () => {
    forgeLock(testDir, null, LOCK_STALE_MS + 60_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('breaks an OLD lock with a CORRUPT pid file', () => {
    forgeLock(testDir, 'not-a-pid', LOCK_STALE_MS + 60_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('does NOT rob a FRESH unreadable-pid lock (holder may be mid-acquire)', () => {
    // A real holder sits in this state for microseconds. Age is the only thing
    // separating "mid-acquire" from "died mid-acquire" — so a fresh one is safe.
    forgeLock(testDir, '', 0);
    expect(acquireLock(testDir)).toBe(false);
  });

  it('still refuses a lock held by a LIVE process, however old', () => {
    forgeLock(testDir, String(process.pid), LOCK_STALE_MS + 60_000);
    expect(acquireLock(testDir)).toBe(false);
  });

  it('still breaks a lock held by a DEAD pid (pre-existing behaviour preserved)', () => {
    // PID 2^22 is above Linux default pid_max — reliably not a live process.
    forgeLock(testDir, '4194304', 0);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });
});

describe('inspectLock', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-inspect-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when there is no lock', () => {
    expect(inspectLock(testDir)).toBeNull();
  });

  it('reports an unreadable pid and the lock age — the tell that was missing', () => {
    forgeLock(testDir, '', 90_000);
    const info = inspectLock(testDir)!;
    expect(info).not.toBeNull();
    expect(info.pidUnreadable).toBe(true);
    expect(info.pid).toBeUndefined();
    expect(info.ageMs).toBeGreaterThanOrEqual(89_000);
  });

  it('reports the holding pid when readable', () => {
    expect(acquireLock(testDir)).toBe(true);
    const info = inspectLock(testDir)!;
    expect(info.pidUnreadable).toBe(false);
    expect(info.pid).toBe(process.pid);
    releaseLock(testDir);
  });
});
