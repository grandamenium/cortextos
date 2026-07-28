/**
 * Locked read-modify-write for the instance agent registry
 * (`<ctxRoot>/config/enabled-agents.json`).
 *
 * Lives here rather than in a route because more than one route mutates the
 * registry, and the protocol below is easy to get subtly, silently wrong.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { withFileLockSync } from '@/lib/file-lock';

// The framework's lock blocks the thread via Atomics.wait.  In a route handler
// that stalls every other request this worker is serving, so we wait far less
// than the library's 5s default: the critical section is two small synchronous
// fs calls, so real contention clears in single-digit milliseconds.  Anything
// slower is a stuck holder, and failing fast beats freezing the dashboard.
const REGISTRY_LOCK_TIMEOUT_MS = 250;

export function enabledAgentsPath(): string {
  return path.join(getCTXRoot(), 'config', 'enabled-agents.json');
}

/**
 * Read-modify-write `enabled-agents.json` while holding the framework's
 * inter-process lock on its directory.
 *
 * `mutate` MUST stay synchronous, and so must every fs call inside it.
 * `withFileLockSync` releases the lock in a `finally` the moment the callback
 * RETURNS — an `async` callback returns a pending Promise immediately, so the
 * lock would be dropped before the write ever ran.  That failure is silent:
 * the code still looks locked and protects nothing, and it type-checks clean
 * (`T` simply infers `Promise<void>`), so the compiler will never catch it.
 * Hence `readFileSync` / `writeFileSync` here rather than the `fs/promises`
 * used elsewhere in the routes.
 *
 * The read happens INSIDE the lock, so callers must not pass state they read
 * earlier — `mutate` receives the freshly-read registry.
 *
 * SCOPE OF THE EXCLUSION — do not overstate this.  Locking here excludes other
 * dashboard requests and the agent processes that take this same lock.  It does
 * NOT exclude the CLI writers of this file (`enable-agent.ts`, `start.ts`,
 * `import-agent.ts`, `install.ts`, `add-agent.ts`), none of which take any lock
 * today.  Against those, a lost update is still possible and no amount of care
 * on this side prevents it; that half is tracked separately.  Any ownership
 * check a caller does inside `mutate` is therefore sound against locked writers
 * only.
 */
export function mutateEnabledAgents(mutate: (agents: Record<string, any>) => void): void {
  const file = enabledAgentsPath();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  withFileLockSync(dir, () => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch (err) {
      // Only "not there yet" is recoverable.  A permissions or I/O error must
      // propagate rather than be treated as an empty registry.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      raw = '{}';
    }
    // Deliberately NOT caught: a malformed registry means we cannot know what
    // the other entries were, and writing our mutation on top of `{}` would
    // deregister every other agent.  Fail loudly and leave the file intact.
    const agents: Record<string, any> = JSON.parse(raw);
    mutate(agents);

    // Write via a temp file + rename rather than in place.  Because we throw on
    // malformed JSON above, a crash partway through an in-place write would
    // leave truncated JSON that makes every later registry call fail — one
    // unlucky moment would take out create and lifecycle until someone repaired
    // the file by hand.  `renameSync` within the same directory is atomic, so a
    // reader sees either the old registry or the new one.
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(agents, null, 2) + '\n', 'utf-8');
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // temp file may not exist; the original write error is what matters
      }
      throw err;
    }
  }, { timeoutMs: REGISTRY_LOCK_TIMEOUT_MS });
}
