import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The mid-release takeover test has to run code at the instant lock.ts reads a
// pid file — the one hook that exists in ANY implementation of an
// ownership-checked release, however it is structured. `vi.spyOn(fs, ...)` is
// not available (ESM module namespaces are not configurable), so the module is
// wrapped once here and left as a pure passthrough unless a test arms the hook.
const hooks = vi.hoisted(() => ({
  /** Runs immediately AFTER a successful read — the check-then-act window. */
  afterPidRead: null as ((path: string) => void) | null,
  /** Runs BEFORE a read, so it may throw to simulate a transient failure. */
  beforeRead: null as ((path: string) => void) | null,
  /** Runs BEFORE a write, so it may throw to simulate a failing pid write. */
  beforeWrite: null as ((path: string) => void) | null,
}));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    default: real,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      hooks.beforeRead?.(String(p));
      const out = (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      hooks.afterPidRead?.(String(p));
      return out;
    },
    writeFileSync: (p: unknown, ...rest: unknown[]) => {
      hooks.beforeWrite?.(String(p));
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../../../src/utils/lock';

// Thresholds mirrored from src/utils/lock.ts. Kept as literals so a silent
// change to the source constants shows up here as a failure rather than
// being followed automatically.
const PIDLESS_STEAL_AFTER_MS = 30_000;
const UNVERIFIABLE_STEAL_AFTER_MS = 300_000;

/** Real start time of a pid, the same way lock.ts reads it. */
function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const f = stat.slice(close + 2).split(' ')[19];
    return f !== undefined && /^\d+$/.test(f) ? f : null;
  } catch {
    return null;
  }
}

const HAVE_PROC = startTimeOf(process.pid) !== null;

/**
 * A pid that is valid to signal but certainly not in use, so process.kill
 * answers ESRCH ("provably dead") rather than an argument error. Scanning down
 * from pid_max keeps this correct on any host instead of hard-coding a number.
 */
function deadPid(): number {
  const max = parseInt(readFileSync('/proc/sys/kernel/pid_max', 'utf-8').trim(), 10);
  for (let p = max - 1; p > max - 500; p--) {
    try {
      process.kill(p, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return p;
    }
  }
  throw new Error('could not find an unused pid');
}

/** Does pid 1 exist but refuse our signals? That is the real EPERM case. */
function pid1IsUnsignalable(): boolean {
  try {
    process.kill(1, 0);
    return false; // signalable (e.g. running as root) — not the case we want
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('mkdir-based locking', () => {
  let testDir: string;
  let lockDir: string;
  let pidFile: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
    lockDir = join(testDir, '.lock.d');
    pidFile = join(lockDir, 'pid');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Plant a held lock with an exact pid-file body. */
  function plantLock(body: string): void {
    mkdirSync(lockDir);
    writeFileSync(pidFile, body);
  }

  /** Backdate the lock dir so age-based recovery sees it as old. */
  function ageLock(ms: number): void {
    const when = (Date.now() - ms) / 1000;
    utimesSync(lockDir, when, when);
  }

  // ---------------------------------------------------------------- baseline

  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    // Same process: the holder is provably alive and provably us, so the
    // second acquire must be refused.
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // ------------------------------------------- only ESRCH may prove death

  // Mutation: revert holderVerdict to a bare `catch { /* dead */ }`.
  // Uses no mocking — pid 1 genuinely exists and genuinely refuses our
  // signals with EPERM when we are not root.
  it.skipIf(!pid1IsUnsignalable() || !HAVE_PROC)(
    'refuses a lock held by a live process we are not allowed to signal (EPERM, pid 1)',
    () => {
      plantLock(`1 ${startTimeOf(1)}`);
      expect(acquireLock(testDir)).toBe(false);
      expect(existsSync(pidFile)).toBe(true);
    },
  );

  // The same rule, forced rather than observed, so it is covered even where
  // pid 1 happens to be signalable (container running as root).
  it('treats an EPERM liveness probe as alive, not dead', () => {
    plantLock('424242 12345');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const e = new Error('EPERM') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    });
    try {
      // EPERM proves existence; the recorded start time cannot be corroborated
      // for a pid that is not really there, so this is 'unverifiable' — and a
      // fresh lock must still be refused rather than stolen.
      expect(acquireLock(testDir)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it.skipIf(!HAVE_PROC)('steals a lock whose holder is provably gone (ESRCH)', () => {
    plantLock(`${deadPid()} 12345`);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // A pid outside the signalable range is an argument error, not ESRCH, so it
  // is NOT proof of death. It must fall to the conservative 'unverifiable'
  // path — refused while fresh, recovered only on the longer threshold.
  it('treats an out-of-range pid record as unverifiable, not as a dead holder', () => {
    plantLock('4294967290 12345');
    expect(acquireLock(testDir)).toBe(false);
    ageLock(PIDLESS_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(false); // still not the right threshold
    ageLock(UNVERIFIABLE_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // --------------------------------------------------- PID reuse detection

  // Mutation: drop the start-time comparison in holderVerdict.
  // Our own pid is unquestionably alive, so only the start-time mismatch can
  // justify the steal — no mocking, no timing.
  it.skipIf(!HAVE_PROC)(
    'steals a lock whose recorded start time does not match the live pid (PID reuse)',
    () => {
      plantLock(`${process.pid} 1`); // real live pid, impossible start tick
      expect(acquireLock(testDir)).toBe(true);
      expect(readFileSync(pidFile, 'utf-8')).toBe(`${process.pid} ${startTimeOf(process.pid)}`);
      releaseLock(testDir);
    },
  );

  it.skipIf(!HAVE_PROC)('refuses a lock whose recorded start time matches the live pid', () => {
    plantLock(`${process.pid} ${startTimeOf(process.pid)}`);
    expect(acquireLock(testDir)).toBe(false);
  });

  // ------------------------------------------------- non-positive pid guard

  // Mutation: drop the `storedPid <= 0` guard. Without it process.kill(0, 0)
  // signals our OWN process group, succeeds, and reads as a live holder —
  // which then needs the much longer unverifiable threshold, so a lock aged
  // just past the pidless threshold stays stuck.
  it('recovers a lock whose pid record is 0 instead of signalling our own process group', () => {
    plantLock('0');
    expect(acquireLock(testDir)).toBe(false); // fresh: still refused
    ageLock(PIDLESS_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('recovers a lock whose pid record is corrupt once it is old enough', () => {
    plantLock('not-a-pid');
    expect(acquireLock(testDir)).toBe(false);
    ageLock(PIDLESS_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // ------------------------------------------------------ pid-less lock dir

  it('refuses a pid-less lock dir that may still be mid-acquire', () => {
    mkdirSync(lockDir); // holder is between mkdir and the pid write
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  // Mutation: drop the pidless age branch -> permanent silent outage.
  it('recovers a pid-less lock dir older than the threshold', () => {
    mkdirSync(lockDir);
    ageLock(PIDLESS_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    releaseLock(testDir);
  });

  // ------------------------------------------ legacy pid-only compatibility

  it('honours a lock written in the legacy pid-only format', () => {
    plantLock(String(process.pid)); // live pid, no start time to corroborate
    expect(acquireLock(testDir)).toBe(false);
  });

  // Mutation: drop the unverifiable age branch.
  it('recovers a legacy pid-only lock once it passes the unverifiable threshold', () => {
    plantLock(String(process.pid));
    ageLock(UNVERIFIABLE_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('does not steal an unverifiable lock before the threshold', () => {
    plantLock(String(process.pid));
    ageLock(UNVERIFIABLE_STEAL_AFTER_MS - 60_000);
    expect(acquireLock(testDir)).toBe(false);
  });

  // ------------------------------------------------ pid write failure clean-up

  // Mutation: drop the rmSync in claimLock's catch. A umask of 0o555 makes the
  // new directory mode 0o222 — writable but not searchable — so creating the
  // pid file inside it fails with EACCES for real. Skipped as root, where
  // permission checks are bypassed.
  it.skipIf(process.getuid?.() === 0)(
    'removes the lock directory when the pid file cannot be written',
    () => {
      const prev = process.umask(0o555);
      try {
        expect(() => acquireLock(testDir)).toThrow();
        expect(existsSync(lockDir)).toBe(false);
      } finally {
        process.umask(prev);
      }
      // The path is not wedged: a normal acquire still works afterwards.
      expect(acquireLock(testDir)).toBe(true);
      releaseLock(testDir);
    },
  );

  // ------------------------------------------------------------ loud signal

  // Mutation: delete the console.error in stealLock. The orchestrator's
  // decision to allow age-based stealing was explicitly conditional on the
  // steal being observable, so silence here is a policy violation, not a
  // cosmetic one.
  it('logs loudly when it steals a lock on inference rather than proof', () => {
    mkdirSync(lockDir);
    ageLock(PIDLESS_STEAL_AFTER_MS + 1_000);
    expect(acquireLock(testDir)).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('STOLE');
    releaseLock(testDir);
  });

  it('does not log when it acquires a free lock', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
    releaseLock(testDir);
  });

  // ------------------------------------------------------------ steal race
  //
  // HONESTY BOUNDARY: this asserts the *outcome* after a steal, not the
  // interleaving itself. The real race the renameSync fixes — rm(A), mkdir(A),
  // rm(B), mkdir(B) with both winning — needs two OS processes scheduled
  // against each other and is NOT reproducible in a single-process test. Do
  // not rename this test to claim it covers the race; it does not.
  it.skipIf(!HAVE_PROC)('leaves exactly one holder after a steal', () => {
    plantLock(`${deadPid()} 12345`); // provably dead holder
    expect(acquireLock(testDir)).toBe(true);
    expect(acquireLock(testDir)).toBe(false); // we now hold it; nobody else may
    releaseLock(testDir);
  });

  // The rename wins us exclusive custody of the directory, but the staleness
  // verdict was formed BEFORE it. If the lock turns over in between, renaming
  // "the stale lock" actually renames a live one — so custody is where the
  // identity has to be re-checked.
  it('aborts a steal when the lock turns over between the verdict and the rename', () => {
    plantLock(`${deadPid()}`); // verdict will be 'dead' → steal

    const newHolder = '999999 12345';
    // Fires at the instant stealLock builds its temp name: after the verdict,
    // before the rename. That is exactly the window a competing process would
    // use to free the dead lock and claim it. Everything else is real fs.
    const hrSpy = vi.spyOn(process.hrtime, 'bigint').mockImplementationOnce(() => {
      writeFileSync(pidFile, newHolder);
      return 1n;
    });

    try {
      expect(acquireLock(testDir)).toBe(false); // must not steal a live lock
      expect(existsSync(lockDir)).toBe(true);   // must have put it back
      expect(readFileSync(pidFile, 'utf-8')).toBe(newHolder); // holder unharmed
      // A SUCCESSFUL restore is not evidence of no harm: it can land on a third
      // acquirer's empty directory and destroy its claim invisibly. Entering the
      // window at all is the only thing observable from this side, so it is
      // reported. Silence here would hide the residual entirely.
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]![0])).toContain('aborted a steal')
    } finally {
      hrSpy.mockRestore();
    }
  });

  // ------------------------------------------------- ownership-checked release
  //
  // Without this, one accepted steal cascades: the stolen-from holder wakes,
  // finishes, and releases — deleting the NEW holder's lock, letting a third
  // acquirer in with no steal and no log anywhere. The steal is loud; the
  // overlap it seeds would be silent.
  it('refuses to release a lock that has been taken over by another holder', () => {
    expect(acquireLock(testDir)).toBe(true);

    const newHolder = '999999 12345';
    writeFileSync(pidFile, newHolder); // we were stolen from while frozen

    releaseLock(testDir);

    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(newHolder);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('declined to remove');
  });

  // The test above is necessary but NOT sufficient, and believing otherwise is
  // what this one exists to correct. It rewrites the pid file BEFORE the
  // release, so the ownership check simply sees a stranger and declines — which
  // a naive check-then-delete implementation also does, correctly. It therefore
  // passes whether or not the gap between the check and the delete is guarded,
  // while being named for exactly that invariant.
  //
  // The defect lives entirely in that gap: read the record, judge it ours, and
  // the lock can still turn over before the rmSync lands. `force: true` then
  // deletes the NEW holder's live directory, and a third acquirer walks in with
  // no steal logged anywhere — the same silent cascade the ownership check was
  // added to prevent, reintroduced one statement below it.
  it('does not delete the new holder\'s lock when the takeover lands mid-release', () => {
    expect(acquireLock(testDir)).toBe(true);

    const newHolder = '999999 12345';
    let taken = false;

    // Fires on the pid read that forms the ownership verdict: the instant an
    // implementation has decided "this is mine" but has not yet removed
    // anything. A competing process frees our lock and claims the path right
    // here. Whatever we do next must not destroy what it created.
    hooks.afterPidRead = (p: string) => {
      if (taken || !p.endsWith('pid')) return;
      taken = true;
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(pidFile, newHolder);
    };

    try {
      releaseLock(testDir);
    } finally {
      hooks.afterPidRead = null;
    }

    expect(taken).toBe(true); // the window was actually entered
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(newHolder);
  });

  // A bare parseInt reads "1234abc" as pid 1234. If that pid happens to be
  // dead, partial corruption would license an immediate steal on an identity
  // nobody ever wrote — so the record is parsed all-or-nothing.
  it('does not steal on a half-parsable pid record naming a dead process', () => {
    plantLock(`${deadPid()}abc`);
    // Corrupt, and far younger than the recovery threshold: refuse and retry.
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('refuses to release a lock whose pid file has vanished', () => {
    expect(acquireLock(testDir)).toBe(true);
    rmSync(pidFile);

    releaseLock(testDir);

    // Cannot prove the dir is ours, so leave it: the age thresholds in
    // acquireLock recover a pidless dir, and deleting a stranger's is worse.
    expect(existsSync(lockDir)).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------- failed-claim cleanup is custody
  //
  // The cleanup after a failed pid write is a delete-by-pathname on a directory
  // we created — and between our mkdir and our cleanup, that pathname can come
  // to name someone else's lock. The pid-less directory we left behind is
  // precisely what acquireLock steals after PIDLESS_STEAL_AFTER_MS, so a slow
  // failing write is enough. Same defect class as the mid-release takeover.
  it('does not delete a lock that replaced ours when our pid write fails', () => {
    const foreign = '999999 12345';
    hooks.beforeWrite = (p: string) => {
      if (!p.endsWith('pid')) return;
      hooks.beforeWrite = null;
      // A competing acquirer judged our pid-less dir stale and now holds it.
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(pidFile, foreign);
      const err: NodeJS.ErrnoException = new Error('simulated pid write failure');
      err.code = 'EACCES';
      throw err;
    };

    try {
      expect(() => acquireLock(testDir)).toThrow();
    } finally {
      hooks.beforeWrite = null;
    }

    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(foreign); // holder unharmed
  });

  // ------------------------------------------ identity is what we WROTE
  //
  // Recomputing the owner record at release time is not idempotent: if
  // readStartTime fails transiently we compute "<pid>" where we stored
  // "<pid> <start>", mismatch against our own lock, and decline to release it.
  // That leak is permanent, not transient — the record names this live process,
  // so every future acquirer judges it 'alive' and no age threshold ever runs.
  it.skipIf(!HAVE_PROC)('releases its own lock even if its identity cannot be recomputed', () => {
    expect(acquireLock(testDir)).toBe(true);

    hooks.beforeRead = (p: string) => {
      if (!p.startsWith('/proc/')) return;
      const err: NodeJS.ErrnoException = new Error('simulated /proc failure');
      err.code = 'EMFILE';
      throw err;
    };

    try {
      releaseLock(testDir);
    } finally {
      hooks.beforeRead = null;
    }

    expect(existsSync(lockDir)).toBe(false);
  });

  // ------------------------------------------------ a failed release is loud
  //
  // Swallowing this is what makes it dangerous. Callers degrade to silence when
  // they cannot acquire (checkInbox returns an empty list), so a wedged lock
  // reads as "nothing to do" rather than as an outage — for as long as this
  // process lives.
  it.skipIf(process.getuid?.() === 0)('shouts when it cannot release the lock at all', () => {
    expect(acquireLock(testDir)).toBe(true);
    chmodSync(testDir, 0o555); // nothing inside can be renamed or unlinked

    try {
      releaseLock(testDir);
    } finally {
      chmodSync(testDir, 0o755);
    }

    expect(existsSync(lockDir)).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('FAILED to release');
  });
});
