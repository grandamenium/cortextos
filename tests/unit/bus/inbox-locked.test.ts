import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkInbox, InboxLockedError } from '../../../src/bus/message';
import { LOCK_STALE_MS } from '../../../src/utils/lock';
import type { BusPaths } from '../../../src/types/index';

/**
 * The bug this file exists for:
 *
 * checkInbox() returned [] when it could not ACQUIRE THE LOCK — the identical
 * value it returns when the inbox is genuinely EMPTY. Callers (the fast-checker
 * poll loop, the CLI, every agent's heartbeat) read [] as "no messages".
 *
 * A hard shutdown left an abandoned lock on one agent's inbox. For three days it
 * reported a clean empty inbox while 26 messages — including an urgent, approved
 * build dispatch — sat queued behind the lock. The failure was visible on disk
 * the entire time and rendered nowhere anyone looked.
 *
 * "Could not read" and "nothing to read" must be different, loud outcomes.
 */
describe('checkInbox: a locked inbox is NOT an empty inbox', () => {
  let root: string;
  let paths: BusPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-inbox-lock-'));
    const inbox = join(root, 'inbox');
    const inflight = join(root, 'inflight');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(inflight, { recursive: true });
    paths = { ctxRoot: root, inbox, inflight } as unknown as BusPaths;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('THROWS instead of returning [] when the lock is held by a live process', () => {
    // Live holder: our own pid, freshly written.
    const lockDir = join(paths.inbox, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));

    expect(() => checkInbox(paths)).toThrow(InboxLockedError);
  });

  it('the error says the inbox was NOT read — not that it was empty', () => {
    const lockDir = join(paths.inbox, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));

    try {
      checkInbox(paths);
      expect.unreachable('checkInbox must throw when the inbox is locked');
    } catch (err) {
      expect(err).toBeInstanceOf(InboxLockedError);
      const e = err as InboxLockedError;
      expect(e.message).toMatch(/LOCKED and was NOT read/);
      expect(e.message).toMatch(/NOT an empty inbox/);
      expect(e.lock?.pid).toBe(process.pid);
    }
  });

  it('returns [] — plainly — when the inbox really is empty', () => {
    expect(checkInbox(paths)).toEqual([]);
  });

  it('self-heals an abandoned lock and reads the queued mail (the production scenario)', () => {
    // A message was queued...
    writeFileSync(
      join(paths.inbox, '1-1783842329443-from-chief-wp1di.json'),
      JSON.stringify({
        id: '1783842329443-chief-wp1di',
        from: 'chief',
        to: 'dev',
        priority: 'high',
        timestamp: '2026-07-12T07:45:29.000Z',
        text: 'COWORKER-BOT UNBLOCKED',
      }),
    );

    // ...behind a lock abandoned by a hard shutdown (empty pid, old).
    const lockDir = join(paths.inbox, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '');
    const old = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    utimesSync(lockDir, old, old);

    // Previously: [] forever. Now: the lock is broken on age and the mail lands.
    const messages = checkInbox(paths);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('1783842329443-chief-wp1di');
  });
});
