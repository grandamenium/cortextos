import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

/**
 * checkInbox used to return `[]` from two states a caller could not tell apart:
 * the inbox was read and was empty, or the lock was busy and the inbox was
 * never read at all. Every test here exists to separate those two states.
 *
 * A test that only asserts "returns []" is the vacuous check that let the
 * original defect ship — it passes just as happily against the broken code.
 */
describe('checkInbox — lock failure is distinguishable from an empty inbox', () => {
  let testDir: string;
  let paths: BusPaths;
  let children: ChildProcess[] = [];

  const lockDir = () => join(paths.inbox, '.lock.d');

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inbox-lock-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    };
  });

  afterEach(() => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    children = [];
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Sleep without yielding to the event loop, matching the lock's own sleep. */
  const spinSleep = (ms: number) => {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  };

  // -------------------------------------------------------------------------
  // State B: the lock is held, the inbox is NOT read.
  // -------------------------------------------------------------------------

  it('throws when the lock is held by a live process, instead of returning []', () => {
    // Seed a real message so an empty result could not be blamed on an empty
    // inbox — if this ever returns [], it is hiding a message.
    sendMessage(paths, 'sender', 'receiver', 'normal', 'must not be silently skipped');

    // process.pid is alive by construction, and acquireLock's staleness check
    // is process.kill(pid, 0) — a self-signal succeeds, so this lands on the
    // genuine "held by a live process" branch rather than the stale-steal path.
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(join(lockDir(), 'pid'), String(process.pid));

    expect(() => checkInbox(paths, { timeoutMs: 100 })).toThrow(/failed to acquire lock/i);
  });

  it('leaves the message in the inbox when the lock is held', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'still here');
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(join(lockDir(), 'pid'), String(process.pid));

    try { checkInbox(paths, { timeoutMs: 100 }); } catch { /* expected */ }

    // Nothing was consumed: the message is still queued, not lost mid-move.
    const queued = readdirSync(paths.inbox).filter(f => f.endsWith('.json'));
    expect(queued).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // State A: the inbox IS read and is genuinely empty. This is the mutation
  // guard — it must fail if checkInbox is "fixed" by throwing unconditionally.
  // -------------------------------------------------------------------------

  it('returns [] for a genuinely empty inbox, without throwing', () => {
    expect(checkInbox(paths)).toEqual([]);
  });

  it('still returns messages normally when the lock is free', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    const messages = checkInbox(paths);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('hello');
  });

  it('releases the lock after a successful read', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'first');
    checkInbox(paths);
    expect(existsSync(lockDir())).toBe(false);

    // Provable by the next call succeeding rather than blocking.
    sendMessage(paths, 'sender', 'receiver', 'normal', 'second');
    expect(checkInbox(paths, { timeoutMs: 100 })).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The retry loop itself. This is the only new mechanism in the fix, and it
  // is the easiest thing to test vacuously.
  //
  // It CANNOT be tested with an in-process timer: withFileLockSync's retry
  // loop is fully synchronous, so no macrotask can run until it returns.
  // It also cannot be tested with a dead-PID stale lock — acquireLock steals
  // that on the FIRST call, so the retry body executes zero times and the test
  // would pass against an implementation with no retry at all.
  //
  // The releaser has to be a genuinely separate process.
  // -------------------------------------------------------------------------

  it('retries past transient contention rather than failing (real retry, not a stale steal)', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'delivered after contention');

    const HOLD_MS = 400;
    const dir = lockDir();
    // Holds the lock with its OWN live pid, then drops it. Because this is a
    // separate process it keeps running while our thread is blocked.
    const script = `
      const { mkdirSync, writeFileSync, rmSync } = require('fs');
      const { join } = require('path');
      mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      writeFileSync(join(${JSON.stringify(dir)}, 'pid'), String(process.pid));
      setTimeout(() => { rmSync(${JSON.stringify(dir)}, { recursive: true, force: true }); }, ${HOLD_MS});
      setTimeout(() => {}, ${HOLD_MS + 2000});
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    children.push(child);

    // Wait for the child to actually own the lock before we try, otherwise we
    // might acquire first and never exercise contention at all.
    const waitStart = Date.now();
    while (!existsSync(join(dir, 'pid')) && Date.now() - waitStart < 5000) {
      spinSleep(10);
    }
    expect(existsSync(join(dir, 'pid'))).toBe(true);

    const start = Date.now();
    const messages = checkInbox(paths, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    // Succeeded rather than throwing...
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('delivered after contention');
    // ...and actually waited for the holder. Without a retry loop this would
    // have thrown immediately; with a stale-steal shortcut it would have
    // returned in ~0ms. The elapsed time is what makes this test non-vacuous.
    expect(elapsed).toBeGreaterThan(100);
  }, 20_000);

  it('gives up and throws when the holder never releases', () => {
    const dir = lockDir();
    const script = `
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      writeFileSync(join(${JSON.stringify(dir)}, 'pid'), String(process.pid));
      setTimeout(() => {}, 30000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    children.push(child);

    const waitStart = Date.now();
    while (!existsSync(join(dir, 'pid')) && Date.now() - waitStart < 5000) {
      spinSleep(10);
    }
    expect(existsSync(join(dir, 'pid'))).toBe(true);

    // A held lock that outlasts the timeout is the wedge case: loud, not [].
    expect(() => checkInbox(paths, { timeoutMs: 300 })).toThrow(/failed to acquire lock/i);
  }, 20_000);
});
