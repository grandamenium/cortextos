/**
 * The dashboard's single point of coupling to the framework's inter-process lock.
 *
 * This deliberately RE-EXPORTS `src/utils/lock.ts` rather than reimplementing the
 * protocol.  The whole reason to lock these JSON stores is to exclude a *different
 * process* — the CLI and the agents — from a read-modify-write window.  Mutual
 * exclusion only holds if both sides create the same `.lock.d` marker, in the same
 * directory, with the same stale-owner semantics.  A dashboard-local copy would be
 * a lock that excludes nothing the moment either copy is changed, and it would fail
 * silently: both sides would take "a lock" and still clobber each other.
 *
 * The import reaches outside `dashboard/` — the only runtime import that does.  That
 * is the point: one crossing, in one file, instead of the protocol being duplicated.
 *
 * It imports the TypeScript source, not `dist/`, so the dashboard build does not
 * depend on the framework having been compiled first.  `lock.ts` imports nothing but
 * `fs` and `path`, so nothing else is pulled across the boundary.
 */
export { withFileLockSync, acquireLock, releaseLock } from '../../../src/utils/lock';
export type { FileLockOptions } from '../../../src/utils/lock';
