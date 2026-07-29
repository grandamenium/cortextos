/**
 * Locked read-modify-write for the instance agent registry
 * (`<ctxRoot>/config/enabled-agents.json`).
 *
 * Five CLI call sites across four files used to do this by hand — read,
 * mutate, `writeFileSync` — with no lock and no shared policy, so two
 * concurrent commands could lose each other's entry. The protocol is easy to
 * get subtly, silently wrong, so it lives here once instead of five times.
 *
 * SCOPE OF THE EXCLUSION — do not overstate it. A lock only excludes writers
 * that take THIS lock, on THIS directory. That means:
 *   - Other CLI commands using this helper: excluded.
 *   - The daemon and any agent process using `withFileLockSync` on the same
 *     directory: excluded.
 *   - The dashboard: excluded only once its own locked helper lands — it
 *     rendezvouses on this same `<ctxRoot>/config/.lock.d` marker via
 *     `dashboard/src/lib/file-lock.ts`, which re-exports `src/utils/lock.ts`
 *     rather than reimplementing the protocol. Until both halves ship, the
 *     CLI<->dashboard race is still open. Do not describe this file as
 *     "closing the race".
 *   - Already-installed older binaries writing this file: NOT excluded, and
 *     not fixable from here. They keep racing until upgraded.
 *
 * The lock is NOT reentrant. Calling `mutateEnabledAgents` from inside a
 * `mutate` callback deadlocks until the lock times out.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withFileLockSync } from './lock.js';
import { atomicWriteSync } from './atomic.js';

/** Directory whose `.lock.d` marker guards the registry. */
export function enabledAgentsDir(ctxRoot: string): string {
  return join(ctxRoot, 'config');
}

export function enabledAgentsPath(ctxRoot: string): string {
  return join(enabledAgentsDir(ctxRoot), 'enabled-agents.json');
}

/**
 * Thrown when the registry exists but is not a JSON object. The original file
 * is left untouched on disk and a copy is preserved at `backupPath`.
 */
export class CorruptRegistryError extends Error {
  readonly path: string;
  readonly backupPath: string | null;

  constructor(path: string, backupPath: string | null, detail: string) {
    super(
      `enabled-agents.json is ${detail} at ${path}. Refusing to overwrite it.\n` +
        (backupPath ? `  A copy was saved to ${backupPath}\n` : '') +
        `  Repair the file, or delete it to reset the registry, then re-run.`,
    );
    this.name = 'CorruptRegistryError';
    this.path = path;
    this.backupPath = backupPath;
  }
}

/**
 * Read-modify-write the registry while holding the inter-process lock on its
 * directory.
 *
 * `mutate` MUST be synchronous, and so must every fs call inside it.
 * `withFileLockSync` releases the lock in a `finally` the moment the callback
 * RETURNS — an `async` callback returns a pending Promise immediately, so the
 * lock would be dropped before the write ever ran. That failure is silent: the
 * code still looks locked, protects nothing, and type-checks clean (`T` simply
 * infers `Promise<void>`), so the compiler will never catch it.
 *
 * The read happens INSIDE the lock, so callers must not pass in state they
 * read earlier — `mutate` receives the freshly-read registry.
 *
 * @param mutate Mutates the registry in place. Return `false` to skip the
 *   write entirely (for "already registered, nothing to do" paths — writing
 *   anyway churns the mtime that the dashboard's file watcher keys on, and
 *   makes callers log a registration that did not happen).
 * @returns `true` if the registry was written, `false` if `mutate` declined.
 * @throws {CorruptRegistryError} if the on-disk registry is not a JSON object.
 * @throws if the lock cannot be acquired within the timeout, or the write fails.
 */
export function mutateEnabledAgents(
  ctxRoot: string,
  mutate: (agents: Record<string, any>) => boolean | void,
): boolean {
  const file = enabledAgentsPath(ctxRoot);
  const dir = enabledAgentsDir(ctxRoot);
  mkdirSync(dir, { recursive: true });

  return withFileLockSync(dir, () => {
    const agents = readRegistryLocked(file);
    const proceed = mutate(agents);
    if (proceed === false) return false;

    // `atomicWriteSync` writes a temp file in this same directory and renames
    // it into place, so a crash mid-write cannot leave truncated JSON — which,
    // combined with the throw above, would otherwise brick every later registry
    // command until someone repaired the file by hand. It appends the trailing
    // newline itself, matching the bytes the old `writeFileSync` calls produced.
    atomicWriteSync(file, JSON.stringify(agents, null, 2));
    return true;
  });
}

/**
 * Read the registry. Caller must already hold the lock.
 *
 * Policy on a malformed file: back it up, warn, and THROW — never overwrite.
 *
 * The three call sites this replaced disagreed on this. `add-agent`, `start`
 * and `import-agent` swallowed the parse error and started from `{}`, which
 * silently rewrote the registry down to a single entry. `enable`/`disable`
 * (BUG-013) at least backed the file up first — but still continued with `{}`,
 * so it was an atomic wipe with a receipt.
 *
 * Both are worse than they look, because a missing entry does NOT mean
 * "disabled". `AgentManager.readInstanceEnableList` returns `{}` when the file
 * is missing or unreadable, and `discoverAndStart` only skips an agent when it
 * finds an explicit `enabled === false`. So losing the registry does not
 * deregister agents — it drops the `enabled: false` flags, and the daemon's
 * next discovery pass STARTS every agent the user deliberately disabled.
 * Unwanted execution, not just lost data. Hence: refuse to write.
 */
function readRegistryLocked(file: string): Record<string, any> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    // Only "not there yet" is recoverable — an empty registry is a legitimate
    // starting state. A permissions or I/O error must propagate rather than be
    // mistaken for one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptRegistryError(file, backup(file, raw), 'not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
    throw new CorruptRegistryError(file, backup(file, raw), `${kind}, not a JSON object`);
  }

  return parsed as Record<string, any>;
}

/** Best-effort copy of a bad registry. Returns the path, or null if it failed. */
function backup(file: string, raw: string): string | null {
  const path = `${file}.broken-${Date.now()}`;
  try {
    writeFileSync(path, raw, 'utf-8');
    return path;
  } catch {
    return null; // the throw that follows is what matters, not the backup
  }
}
