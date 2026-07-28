/**
 * `bus check-inbox` CLI contract when the inbox lock cannot be acquired.
 *
 * The CLI is deliberately ASYMMETRIC with the daemon. The daemon announces the
 * failure and carries on as "no messages", because a crashing fast-checker is
 * worse than a gap. The CLI has no such constraint: it is a one-shot process
 * whose stdout is routinely consumed by shell callers, so printing `[]` when
 * the inbox was never read would propagate the exact silent outage this whole
 * change exists to remove — one level up, into every caller.
 *
 * So: on failure, nothing on stdout, and a non-zero exit status.
 *
 * NOTE: this test invokes the compiled `dist/cli.js` and is skipped when that
 * file is absent (matching the other CLI integration tests, which assume CI
 * ran `npm run build`). Be aware that a skipped test reads as a green one in
 * summary output — if you are using this suite to clear the change, confirm
 * the tests below actually RAN.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

const AGENT = 'probe';
const INSTANCE = 'default';

const suite = existsSync(DIST_CLI) ? describe : describe.skip;

suite('bus check-inbox — CLI exit contract on lock failure', () => {
  let home: string;
  let holder: ChildProcess | null = null;

  // resolvePaths() derives everything from homedir(), not from an env var, so
  // an isolated HOME is what keeps this off the real inbox.
  const inboxDir = () => join(home, '.cortextos', INSTANCE, 'inbox', AGENT);

  const runCheckInbox = () =>
    spawnSync(process.execPath, [DIST_CLI, 'bus', 'check-inbox'], {
      env: {
        ...process.env,
        HOME: home,
        CTX_AGENT_NAME: AGENT,
        CTX_INSTANCE_ID: INSTANCE,
        CTX_ORG: 'testorg',
      },
      encoding: 'utf-8',
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cortextos-cli-inbox-'));
  });

  afterEach(() => {
    if (holder) {
      try { holder.kill('SIGKILL'); } catch { /* already gone */ }
      holder = null;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('exits non-zero and prints nothing to stdout when the lock is held', () => {
    mkdirSync(inboxDir(), { recursive: true });
    const lockDir = join(inboxDir(), '.lock.d');
    mkdirSync(lockDir, { recursive: true });

    // A genuinely live holder process. acquireLock's staleness check is
    // process.kill(pid, 0); a dead pid would be STOLEN on the first attempt,
    // the CLI would succeed, and this test would silently stop testing
    // anything.
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    writeFileSync(join(lockDir, 'pid'), String(holder.pid));

    const res = runCheckInbox();

    expect(res.status).not.toBe(0);
    // The specific regression: never `[]` on stdout. Asserting emptiness alone
    // would be weaker — `[]` is the exact string a caller would misread as a
    // healthy empty inbox.
    expect(res.stdout).not.toContain('[]');
    expect(res.stdout.trim()).toBe('');
    // The reason goes to stderr, where it cannot be captured by `$(...)` into
    // a caller's message list.
    expect(res.stderr).toMatch(/inbox could not be read/i);
  }, 30_000);

  it('exits zero and prints [] for a genuinely empty inbox', () => {
    // The control arm. Without it, a CLI that failed for some unrelated reason
    // (missing dist, bad env, wrong agent name) would satisfy the assertions
    // above for entirely the wrong reason.
    const res = runCheckInbox();

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('[]');
    expect(res.stderr).not.toMatch(/inbox could not be read/i);
  }, 30_000);
});
