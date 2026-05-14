import { statSync } from 'fs';
import { join } from 'path';

/**
 * Fleet-resilience #8 — detect a `node_modules` reinstall during daemon
 * lifetime. The 2026-05-14 outage's root cause was exactly this: a
 * pnpm/npm install replaced node-pty's prebuilt `spawn-helper` binary
 * (dropping its exec bit + invalidating the daemon's cached binding),
 * which made `pty.spawn()` throw `posix_spawnp failed` until the daemon
 * was respawned. PRs #37/#40 catch and recover from that failure mode;
 * this helper catches the precondition one stat call earlier.
 *
 * Returns `stale: true` only when `node_modules/package.json` mtime is
 * strictly newer than `daemonStartedAt`. Missing file or any stat error
 * yields `stale: false` — disk weirdness must NEVER block agent boot.
 *
 * Uses a single `statSync` (no `existsSync` precheck) to avoid a TOCTOU
 * window where an in-flight pnpm install can unlink the file between
 * the existence check and the stat — exactly when we'd want the
 * warning to fire.
 */
export interface NodeModulesMtimeResult {
  stale: boolean;
  mtime?: Date;
}

export function checkNodeModulesMtime(
  frameworkRoot: string,
  daemonStartedAt: Date,
): NodeModulesMtimeResult {
  try {
    const pkg = join(frameworkRoot, 'node_modules', 'package.json');
    const st = statSync(pkg);
    const mtime = st.mtime;
    if (mtime.getTime() > daemonStartedAt.getTime()) {
      return { stale: true, mtime };
    }
    return { stale: false, mtime };
  } catch {
    // Any error (ENOENT, EACCES, mid-install race) → no warning. Cause was
    // unobservable; never block agent boot on disk weirdness.
    return { stale: false };
  }
}
