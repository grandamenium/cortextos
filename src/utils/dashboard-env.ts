/**
 * Locked, merge-preserving access to `<ctxRoot>/dashboard.env`.
 *
 * Two independent processes write this file:
 *   - `cortextos install` (src/cli/install.ts) — generates credentials on first
 *     run and rewrites the file on every subsequent run.
 *   - `cortextos dashboard` (src/cli/dashboard.ts) — generates and persists an
 *     AUTH_SECRET/ADMIN_PASSWORD when neither the environment nor the file
 *     supplies one.
 *
 * Both used to do a bare read-modify-write. If they interleave while the file
 * is absent or partial, each generates its own secrets and the last writer wins
 * the file — but the dashboard has already captured its own values in memory,
 * passed them to the Next.js child, and printed the admin password to the user.
 * The result is a printed password that does not match the stored one, and an
 * AUTH_SECRET change that invalidates every session on the next boot.
 *
 * Serializing the read-modify-write behind the directory lock is what makes the
 * two writers agree on a single set of credentials.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { atomicWriteSync } from './atomic.js';
import { parseEnvContent, serializeEnvContent } from './env.js';
import { withFileLockSync } from './lock.js';

/** Path to the instance's dashboard credential file. */
export function dashboardEnvPath(ctxRoot: string): string {
  return join(ctxRoot, 'dashboard.env');
}

/**
 * Read `dashboard.env`, apply `mutate`, and write it back — all while holding
 * `ctxRoot`'s lock, so a concurrent writer cannot land between the read and the
 * write.
 *
 * The write is merge-preserving: `mutate` receives every key currently in the
 * file and the whole map is written back. Callers that only care about the
 * credential keys therefore no longer silently drop unrelated keys the user or
 * the other writer put there. (Comments and blank lines are not preserved —
 * neither writer preserved them before this, and the file is generated.)
 *
 * @param ctxRoot Instance root, e.g. `~/.cortextos/default`.
 * @param mutate Mutates the credential map in place. Return `false` to skip the
 *   write entirely — used by the read-only path, so merely starting the
 *   dashboard does not churn the file's mtime or rewrite credentials it did not
 *   change.
 * @returns `true` if the file was written, `false` if `mutate` declined.
 * @throws if the lock cannot be acquired within the timeout, if the existing
 *   file exists but cannot be read, or if the write fails.
 */
export function mutateDashboardEnv(
  ctxRoot: string,
  mutate: (creds: Record<string, string>, existed: boolean) => boolean | void,
): boolean {
  const file = dashboardEnvPath(ctxRoot);
  mkdirSync(ctxRoot, { recursive: true });

  return withFileLockSync(ctxRoot, () => {
    // Deliberately not `parseEnvFile`: that swallows read errors and returns
    // `{}`, which here would be indistinguishable from "no file yet" and would
    // make an unreadable file get overwritten with freshly generated
    // credentials. Absent means absent; unreadable throws.
    const existed = existsSync(file);
    const creds = existed ? parseEnvContent(readFileSync(file, 'utf-8')) : {};

    const proceed = mutate(creds, existed);
    if (proceed === false) return false;

    // `atomicWriteSync` writes a temp file in this same directory with mode
    // 0o600 and renames it into place, so the credentials are never readable by
    // other users and a crash mid-write cannot leave a truncated file. It
    // appends the trailing newline itself.
    atomicWriteSync(file, serializeEnvContent(creds));
    return true;
  });
}
