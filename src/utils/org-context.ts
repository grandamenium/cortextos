/**
 * Locked read-modify-write for the per-org context file
 * (`<frameworkRoot>/orgs/<org>/context.json`).
 *
 * Three CLI sites used to do this by hand — `existsSync` then `writeFileSync`,
 * or read/mutate/write — with no lock, so two concurrent commands could lose
 * each other's changes wholesale. `cortextos init` racing
 * `cortextos add-agent --template orchestrator` is the realistic pair: both
 * read the whole object, mutate a few fields, and write the whole object back.
 *
 * SCOPE OF THE EXCLUSION — do not overstate it. A lock only excludes writers
 * that take THIS lock, on THIS directory:
 *   - Other CLI commands using this helper: excluded.
 *   - The dashboard: `dashboard/src/lib/file-lock.ts` re-exports
 *     `src/utils/lock.ts` rather than reimplementing the protocol, and both
 *     sides resolve this file to `<frameworkRoot>/orgs/<org>/`, so the
 *     rendezvous is real — but the dashboard does not take it yet.
 *     `dashboard/src/app/api/org/config/route.ts:72-77` is still an unlocked
 *     read-modify-write. Until that lands, CLI<->dashboard is still open.
 *   - Already-installed older binaries writing this file: NOT excluded, and
 *     not fixable from here.
 *
 * The sibling per-agent `config.json` deliberately does NOT get a helper here.
 * The dashboard's `getAgentDir()` falls back to `<CTX_ROOT>/...` when the
 * framework-root path is missing, while the CLI only ever looks under the
 * framework root — so the two sides can resolve different directories for the
 * same agent, precisely during creation. A directory lock there would exclude
 * nothing in the window where the race lives. Tracked separately; reconcile the
 * path resolution first.
 *
 * The lock is NOT reentrant. Calling `mutateOrgContext` from inside a `mutate`
 * callback deadlocks until the lock times out.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withFileLockSync } from './lock.js';
import { atomicWriteSync } from './atomic.js';
import { stripBom } from './strip-bom.js';

/** Directory whose `.lock.d` marker guards this org's context file. */
export function orgContextDir(frameworkRoot: string, org: string): string {
  return join(frameworkRoot, 'orgs', org);
}

export function orgContextPath(frameworkRoot: string, org: string): string {
  return join(orgContextDir(frameworkRoot, org), 'context.json');
}

/**
 * Thrown when the context file exists but is not a JSON object. The original
 * file is left untouched on disk and a copy is preserved at `backupPath`.
 */
export class CorruptOrgContextError extends Error {
  readonly path: string;
  readonly backupPath: string | null;

  constructor(path: string, backupPath: string | null, detail: string) {
    super(
      `context.json is ${detail} at ${path}. Refusing to overwrite it.\n` +
        (backupPath ? `  A copy was saved to ${backupPath}\n` : '') +
        `  Repair the file, or delete it to reset the org context, then re-run.`,
    );
    this.name = 'CorruptOrgContextError';
    this.path = path;
    this.backupPath = backupPath;
  }
}

/**
 * Read-modify-write this org's context file while holding the inter-process
 * lock on its directory.
 *
 * `mutate` MUST be synchronous, and so must every fs call inside it.
 * `withFileLockSync` releases the lock in a `finally` the moment the callback
 * RETURNS — an `async` callback returns a pending Promise immediately, so the
 * lock would be dropped before the write ever ran. That failure is silent: the
 * code still looks locked, protects nothing, and type-checks clean (`T` simply
 * infers `Promise<void>`), so the compiler will never catch it.
 *
 * Hold time matters here beyond the usual. The dashboard caps its lock wait at
 * 250ms (`dashboard/src/lib/enabled-agents.ts:18`) because `Atomics.wait`
 * blocks a whole Next.js worker — so a CLI that holds this lock longer than
 * that makes dashboard writes *throw*, not queue. Keep `mutate` to in-memory
 * work; do no I/O beyond the read and write this function already performs.
 *
 * The read happens INSIDE the lock, so callers must not pass in state they read
 * earlier — `mutate` receives the freshly-read context.
 *
 * @param mutate Mutates the context in place. Receives `existed: false` when
 *   the file was absent and `ctx` is therefore a fresh `{}` — that is how the
 *   old `existsSync`-then-create branch is expressed without the TOCTOU.
 *   Return `false` to skip the write entirely (for "nothing to change" paths —
 *   writing anyway churns the mtime that the dashboard's file watcher keys on).
 * @returns `true` if the file was written, `false` if `mutate` declined.
 * @throws {CorruptOrgContextError} if the on-disk file is not a JSON object.
 * @throws if the lock cannot be acquired within the timeout, or the write fails.
 */
export function mutateOrgContext(
  frameworkRoot: string,
  org: string,
  mutate: (ctx: Record<string, any>, existed: boolean) => boolean | void,
): boolean {
  const dir = orgContextDir(frameworkRoot, org);
  const file = orgContextPath(frameworkRoot, org);
  mkdirSync(dir, { recursive: true });

  return withFileLockSync(dir, () => {
    const { ctx, existed } = readContextLocked(file);
    const proceed = mutate(ctx, existed);
    if (proceed === false) return false;

    // `atomicWriteSync` writes a temp file in this same directory and renames
    // it into place, so a crash mid-write cannot leave truncated JSON. The
    // three call sites this replaced all used a bare `writeFileSync`, which is
    // not atomic per-write either — and every reader of this file swallows
    // parse errors and silently keeps defaults (`src/utils/env.ts:76-88`,
    // `src/daemon/agent-manager.ts:736-742`), so a torn read here disables
    // org wiring with no diagnostic at all. It appends the trailing newline
    // itself, matching the bytes the old calls produced.
    atomicWriteSync(file, JSON.stringify(ctx, null, 2));
    return true;
  });
}

/**
 * Read the context file. Caller must already hold the lock.
 *
 * Policy on a malformed file: back it up, warn, and THROW — never overwrite.
 *
 * This is the same policy as the agent registry, but it is NOT justified by the
 * same consequence, so it is worth restating. Losing this file does not cause
 * unwanted execution; it degrades quietly. `resolveEnv` stops resolving the org
 * timezone and orchestrator, `AgentManager` stops starting the activity-channel
 * poller, and `checkDeliverableRequirement` fails open so the deliverables gate
 * silently turns off. Every one of those readers swallows the error.
 *
 * The reason to refuse the write is what the WRITERS would otherwise do. Both
 * remaining mutations are fill-in-the-missing-fields passes over a parsed
 * object. If a parse failure were treated as "start from `{}`", `cortextos init`
 * would helpfully rewrite a corrupt-but-recoverable file down to bare defaults
 * — discarding the org's description, ICP, value prop and orchestrator, and
 * reporting success. Refusing costs a re-run; the alternative destroys data
 * that only exists here.
 */
function readContextLocked(file: string): { ctx: Record<string, any>; existed: boolean } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    // Only "not there yet" is recoverable — a brand-new org legitimately has no
    // context file. A permissions or I/O error must propagate rather than be
    // mistaken for one and then overwritten.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { ctx: {}, existed: false };
  }

  let parsed: unknown;
  try {
    // stripBom: see src/utils/strip-bom.ts. Without it a BOM-prefixed file
    // fails to parse, which previously made every re-run of `cortextos init`
    // fall through to its catch and leave the file un-upgraded forever.
    parsed = JSON.parse(stripBom(raw));
  } catch {
    throw new CorruptOrgContextError(file, backup(file, raw), 'not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
    throw new CorruptOrgContextError(file, backup(file, raw), `${kind}, not a JSON object`);
  }

  return { ctx: parsed as Record<string, any>, existed: true };
}

/** Best-effort copy of a bad context file. Returns the path, or null if it failed. */
function backup(file: string, raw: string): string | null {
  const path = `${file}.broken-${Date.now()}`;
  try {
    writeFileSync(path, raw, 'utf-8');
    return path;
  } catch {
    return null; // the throw that follows is what matters, not the backup
  }
}
