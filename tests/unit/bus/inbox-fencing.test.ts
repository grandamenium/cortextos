import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types/index';

/**
 * WHY THE INBOX SURVIVES A DOUBLE-HOLDER — and why we are NOT adding an epoch.
 *
 * Three review rounds produced three real races in the stale-lock steal, and the
 * honest reading is that safely stealing a filesystem lock is a known-hard
 * problem: every scheme reduces to "decide, then act", and the gap between decide
 * and act is where the next interleaving lives. Assume a fourth exists.
 *
 * The standard answer is FENCING: don't try to make the race impossible, make it
 * unable to cause damage — the critical section verifies it still owns the
 * resource before each destructive act, so a stale holder's write is rejected
 * rather than applied.
 *
 * THE INBOX ALREADY HAS THIS, and not by accident of ours — by the filesystem.
 * Every mutation in the critical section is a rename():
 *
 *   checkInbox           inbox/    -> inflight/     (message.ts)
 *   ackInbox             inflight/ -> processed/
 *   recoverStaleInflight inflight/ -> inbox/
 *
 * rename() is a compare-and-swap on the source path: if the source is gone, it
 * fails with ENOENT. It cannot be applied twice. So a stale holder that tries to
 * move a message another holder already moved does not corrupt anything — its
 * operation FAILS, which is precisely what a fencing token buys.
 *
 * These tests assert that property, so nobody later "optimises" a rename into a
 * copy+unlink (which is NOT single-winner) and silently removes the fence.
 */
describe('inbox critical section is fenced by rename(), not by the lock alone', () => {
  let root: string;
  let paths: BusPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-fence-'));
    const inbox = join(root, 'inbox');
    const inflight = join(root, 'inflight');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(inflight, { recursive: true });
    paths = { ctxRoot: root, inbox, inflight } as unknown as BusPaths;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function putMessage(id: string): string {
    const file = `1-${id}-from-chief-x.json`;
    writeFileSync(
      join(paths.inbox, file),
      JSON.stringify({ id, from: 'chief', to: 'dev', priority: 'high', timestamp: '2026-07-12T00:00:00.000Z', text: 'x' }),
    );
    return file;
  }

  it('rename() is single-winner: a second mover of the same file FAILS', () => {
    // The property the whole fence rests on. If this ever stops holding, the
    // inbox is only as safe as the lock — and the lock is a hard problem.
    const file = putMessage('m1');
    const src = join(paths.inbox, file);
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));

    renameSync(src, join(root, 'a', file)); // holder A wins
    expect(() => renameSync(src, join(root, 'b', file))).toThrow(/ENOENT/); // stale holder B loses

    expect(existsSync(join(root, 'a', file))).toBe(true);
    expect(existsSync(join(root, 'b', file))).toBe(false);
  });

  it('a message consumed by one holder is NOT re-delivered to another', () => {
    // Simulates the damage a double-holder would do: both list the inbox, both
    // try to take the same message. Exactly one may deliver it.
    putMessage('m1');
    putMessage('m2');

    const first = checkInbox(paths);
    expect(first.map((m) => m.id).sort()).toEqual(['m1', 'm2']);

    // A stale holder now runs the same critical section. The files are gone from
    // inbox (already moved to inflight), so it delivers nothing — no duplicates.
    const second = checkInbox(paths);
    expect(second).toEqual([]);
  });

  it('a message is never LOST when a holder takes it but never ACKs it', () => {
    // The other half of the guarantee: the loser of a race does not silently drop
    // the message. It sits in inflight and recoverStaleInflight returns it to the
    // inbox, so it is redelivered rather than lost.
    putMessage('m1');
    checkInbox(paths); // moved to inflight, never ACKed

    expect(readdirSync(paths.inflight)).toHaveLength(1);
    expect(readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    // Age it past the 5-minute inflight-recovery window.
    const file = readdirSync(paths.inflight)[0];
    const old = new Date(Date.now() - 10 * 60 * 1000);
    require('fs').utimesSync(join(paths.inflight, file), old, old);

    const redelivered = checkInbox(paths);
    expect(redelivered.map((m) => m.id)).toEqual(['m1']);
  });
});
