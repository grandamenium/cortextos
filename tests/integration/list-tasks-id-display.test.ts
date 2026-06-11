/**
 * tests/integration/list-tasks-id-display.test.ts — regression guard for #587.
 *
 * `bus list-tasks` truncated task ids in the table (hardcoded 26-char column vs.
 * 27-char `task_<13>_<8>` ids), so an id copy-pasted from the table into
 * complete-task/update-task silently targeted the wrong (or no) task. This drives
 * the compiled CLI: create a task, read the FULL id back out of the list-tasks
 * TABLE output (not --format json), and confirm complete-task accepts it.
 *
 * Invokes `dist/cli.js`, so it assumes `npm run build` ran (CI does). If
 * dist/cli.js is absent, the suite is skipped rather than failing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let ctxRoot: string;

// CTX_AGENT_NAME must be a valid agent name; without it the CLI falls back to the
// cwd basename, which is rejected if it isn't `[a-z0-9_-]` only.
function env() {
  return { ...process.env, CTX_AGENT_NAME: 'orchestrator', CTX_ROOT: ctxRoot, CTX_ORG: 'lifeos' };
}
async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DIST_CLI, 'bus', ...args], { env: env() });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
  }
}

beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'list-tasks-id-')); });
afterEach(() => { try { rmSync(ctxRoot, { recursive: true }); } catch { /* ignore */ } });

describe.skipIf(!existsSync(DIST_CLI))('bus list-tasks id display (#587)', () => {
  it('shows the FULL task id in the table — copy-paste into complete-task works', async () => {
    const created = await cli(['create-task', 'Regression for 587', '--assignee', 'orchestrator']);
    const fullId = created.stdout.match(/task_\d+_\d+/)?.[0];
    expect(fullId, 'create-task should print a full task id').toBeTruthy();
    expect(fullId!.length).toBe(27); // task_ + 13-digit epoch + _ + 8-digit rand

    const list = await cli(['list-tasks', '--agent', 'orchestrator']);
    // The exact full id must appear in the human table (the bug truncated it).
    expect(list.stdout).toContain(fullId!);

    // And the id pulled straight from the table row must drive complete-task.
    const tableId = list.stdout.split('\n')
      .map((l) => l.match(/task_\d+_\d+/)?.[0])
      .find(Boolean);
    expect(tableId).toBe(fullId);
    const done = await cli(['complete-task', tableId!, '--result', 'ok']);
    expect(done.code).toBe(0);
  });
});
