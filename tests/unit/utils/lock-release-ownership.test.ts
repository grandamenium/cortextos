/**
 * `releaseLock` must touch a lock directory ONLY while this process actually
 * holds that acquisition.
 *
 * Both halves of that live in the `heldRecords` map, and both were broken in
 * ways the existing suite is blind to — every test in `lock.test.ts` passes
 * before and after this change, so none of them is evidence for it.
 *
 *   - No entry meant "recompute the record and try anyway", so a stray release
 *     took custody of a healthy FOREIGN lock: renamed it aside, read it, renamed
 *     it back.  That is not a read-only mistake — the restore window is the one
 *     documented on `removeWithCustody`, where a third acquirer's fresh claim can
 *     be destroyed — and it logs "data guarded by it may be torn. Investigate",
 *     which is a false alarm someone has to chase.
 *   - An entry that survived a failed release meant the map named a PROCESS
 *     rather than an ACQUISITION.
 *
 * WHAT THE SECOND FIX DOES AND DOES NOT CLOSE.  Clearing the entry makes a
 * duplicate release after a failed one a no-op instead of an operation on
 * whatever occupies the path now.  It does NOT make double-release safe in
 * general: if this process RE-ACQUIRES the same path, `claimLock` writes a
 * byte-identical record and repopulates the map, so a delayed release still
 * matches and removes the new acquisition.  Closing that needs a generation
 * nonce in the record, which is a format migration (the record is parsed by a
 * fixed regex) and is deliberately not attempted here.  The invariant these
 * tests establish is the narrower one in the first line, and no more.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../../../src/utils/lock';

let root: string;
let dir: string;
let lockDir: string;
let errs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lockown-'));
  dir = join(root, 'target');
  mkdirSync(dir);
  lockDir = join(dir, '.lock.d');
  errs = [];
  vi.spyOn(console, 'error').mockImplementation(msg => { errs.push(String(msg)); });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { chmodSync(dir, 0o755); } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true });
});

/** Every sibling `.lock.d.release.*` custody directory left behind. */
const custodyTemps = () => readdirSync(dir).filter(f => f.startsWith('.lock.d.release.'));

/** A live lock belonging to someone else. pid 1 exists and is not us. */
function plantForeignLock(): void {
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'pid'), '1');
}

describe('releaseLock on a lock this process does not hold', () => {
  it('does nothing — no custody, no restore window, no false alarm', () => {
    plantForeignLock();

    releaseLock(dir);

    // The claim: not merely "the lock survived" — the code never went near it.
    // Under the old `?? ownerRecord()` fallback this logs `declined to remove
    // ... data guarded by it may be torn`, having renamed the directory aside
    // and back to find that out.
    expect(errs).toEqual([]);
    expect(custodyTemps()).toEqual([]);

    // Control arm: the lock we planted has to still be a real, intact, foreign
    // lock, or "nothing happened to it" would be true of an empty directory.
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('1');
  });

  it('stays a no-op after our own acquisition ends, so a duplicate release cannot reach a stranger', () => {
    expect(acquireLock(dir)).toBe(true);

    // Our lock is stolen and replaced while we are still inside the critical
    // section: the path now holds someone else's record, not ours.
    writeFileSync(join(lockDir, 'pid'), '1');

    // First release: correctly declines and restores. This one SHOULD log — it
    // is the genuine "we were stolen from" case, and the control arm for the
    // assertion below (an implementation that logs nothing at all would satisfy
    // that assertion vacuously).
    releaseLock(dir);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/declined to remove/);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('1');

    // The acquisition is over, so the record must be gone with it. A second,
    // delayed or duplicated, release must not custody the stranger's lock.
    errs.length = 0;
    releaseLock(dir);
    expect(errs).toEqual([]);
    expect(custodyTemps()).toEqual([]);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('1');
  });
});

describe('releaseLock when the release itself fails', () => {
  it('forgets the acquisition when the lock VANISHED, so a later release cannot reach whoever took the path', () => {
    // The observable consequence of forgetting has to be measured against a
    // path that someone ELSE now holds. Re-acquiring it ourselves proves
    // nothing: `claimLock` writes a byte-identical record and repopulates the
    // map, so the retry succeeds whether or not the entry was ever cleared.
    expect(acquireLock(dir)).toBe(true);

    // Somebody removed our lock directory outright.
    rmSync(lockDir, { recursive: true, force: true });

    releaseLock(dir);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/already gone/);

    // The path really is free — and a stranger takes it. (`plantForeignLock`
    // mkdirs, so it would throw were the path still occupied.)
    expect(existsSync(lockDir)).toBe(false);
    plantForeignLock();

    // A delayed or duplicated release must not touch it. Keeping the record
    // here — treating a vanished lock as still ours — is what would make this
    // custody a stranger's healthy lock and raise a false torn-data alarm.
    errs.length = 0;
    releaseLock(dir);
    expect(errs).toEqual([]);
    expect(custodyTemps()).toEqual([]);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('1');
  });

  it('KEEPS the acquisition when the lock is STUCK, so a retry can still release it', () => {
    // This is the case that makes "clear the record on any failed release"
    // wrong. The directory is still there and still ours, so we are still the
    // holder — and the cached record is the only copy of what we wrote. Forget
    // it and every later release becomes the no-op above, wedging the lock for
    // the life of the process: a live holder is judged 'alive' forever.
    expect(acquireLock(dir)).toBe(true);

    // A rename out of a directory needs write permission on that directory, so
    // this makes the custody rename fail EACCES rather than ENOENT.
    chmodSync(dir, 0o555);
    releaseLock(dir);
    chmodSync(dir, 0o755);

    // Assert we actually hit the stuck path. Without this the test would pass
    // vacuously anywhere the chmod does not bite — as root, for instance.
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/FAILED to release/);
    expect(existsSync(lockDir)).toBe(true);

    // The retry: it must still know the record, and must actually remove it.
    errs.length = 0;
    releaseLock(dir);
    expect(errs).toEqual([]);
    expect(existsSync(lockDir)).toBe(false);
  });
});
