import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';

// Integration test for scripts/auto-pr-upstream.sh. Builds a real (tiny) git
// repo in tmp, wires an "upstream" remote at a local bare clone, and invokes
// the script with a PATH-prepended fake `gh` binary. Assertions inspect a
// log file the fake gh appends to so we can see what subcommand the script
// ran and with which arguments.

const scriptPath = resolve(__dirname, '../../../scripts/auto-pr-upstream.sh');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('scripts/auto-pr-upstream.sh', () => {
  let tmpRoot: string;
  let upstreamBare: string;
  let repoDir: string;
  let fakeBin: string;
  let ghLog: string;

  function git(args: string, opts: { cwd?: string; silent?: boolean } = {}) {
    execSync(`git ${args}`, {
      cwd: opts.cwd ?? repoDir,
      stdio: opts.silent === false ? 'inherit' : 'ignore',
    });
  }

  // Bootstrap a repo with a commit on main pushed to the bare "upstream",
  // then check out a feature branch and stage `touchedPaths`. No remote push
  // for the feature branch — we only need the local diff vs upstream/main.
  function setupRepo(touchedPaths: string[]) {
    execSync(`git init --bare "${upstreamBare}"`, { stdio: 'ignore' });
    execSync(`git clone "${upstreamBare}" "${repoDir}"`, { stdio: 'ignore' });
    git('config user.email test@example.com');
    git('config user.name Test');
    git('config commit.gpgsign false');
    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    git('add README.md');
    git('commit -m init');
    // Some git versions default to `master`; force main.
    git('branch -M main');
    git('push origin main');
    // The `upstream` remote in this test points at the same bare repo so that
    // `git fetch upstream main` and `upstream/main` resolve to the same history
    // origin already tracks. In production origin=fork, upstream=grandamenium.
    git(`remote add upstream "${upstreamBare}"`);
    git('fetch upstream main');
    git('checkout -b feat/test');
    for (const p of touchedPaths) {
      const full = join(repoDir, p);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, `content for ${p}\n`);
      git(`add "${p}"`);
    }
    git('commit -m "feat: change"');
  }

  // Write a fake `gh` that logs its argv and dispatches based on the first
  // two positional args. `behavior` is shell injected after the log line.
  function writeFakeGh(behavior: string) {
    const ghPath = join(fakeBin, 'gh');
    const body = `#!/usr/bin/env bash
# Log each invocation so tests can assert on the dispatched subcommand.
printf '%s\\n' "$*" >> "${ghLog}"
${behavior}
`;
    writeFileSync(ghPath, body);
    chmodSync(ghPath, 0o755);
  }

  function run(extraEnv: Record<string, string> = {}): RunResult {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    };
    const res = spawnSync('bash', [scriptPath], {
      cwd: repoDir,
      env,
      encoding: 'utf8',
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-pr-upstream-'));
    upstreamBare = join(tmpRoot, 'upstream.git');
    repoDir = join(tmpRoot, 'repo');
    fakeBin = join(tmpRoot, 'bin');
    ghLog = join(tmpRoot, 'gh.log');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghLog, '');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('opens a PR when core files changed and no existing PR', () => {
    setupRepo(['src/foo.ts']);
    writeFakeGh(`
case "$1" in
  auth)    [[ "$2" == "status" ]] && exit 0 ;;
  pr)
    case "$2" in
      list)   echo ""; exit 0 ;;
      create) echo "https://github.com/grandamenium/cortextos/pull/42"; exit 0 ;;
    esac ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toMatch(/auth status/);
    expect(log).toMatch(/pr list/);
    expect(log).toMatch(/pr create/);
    expect(log).toMatch(/loganbronstein:feat\/test/);
    expect(log).toMatch(/grandamenium\/cortextos/);
  });

  it('skips when only non-core files changed', () => {
    setupRepo(['community/skills/foo/SKILL.md', 'README-extra.md']);
    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toMatch(/pr create/);
    expect(log).not.toMatch(/pr list/);
  });

  it('skips when a PR is already open for the branch', () => {
    setupRepo(['dashboard/src/page.tsx']);
    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
  pr)
    case "$2" in
      list)   echo "99"; exit 0 ;;
      create) echo "should not have been called" >&2; exit 1 ;;
    esac ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toMatch(/pr list/);
    expect(log).not.toMatch(/pr create/);
  });

  it('treats literal "null" from gh pr list as no-PR', () => {
    // If the jq filter ever regresses and emits the literal string "null"
    // for an empty array, the script must still open the PR rather than
    // bail thinking a PR already exists.
    setupRepo(['src/foo.ts']);
    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
  pr)
    case "$2" in
      list)   echo "null"; exit 0 ;;
      create) echo "https://github.com/grandamenium/cortextos/pull/7"; exit 0 ;;
    esac ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toMatch(/pr create/);
  });

  it('skips when gh is not authenticated', () => {
    setupRepo(['src/foo.ts']);
    writeFakeGh(`
case "$1" in
  auth) exit 1 ;;
esac
exit 1
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toMatch(/pr create/);
  });

  it('does not block push when gh pr create fails (network error)', () => {
    setupRepo(['templates/agent/HEARTBEAT.md']);
    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
  pr)
    case "$2" in
      list)   echo ""; exit 0 ;;
      create) echo "HTTP 500 from api.github.com" >&2; exit 1 ;;
    esac ;;
esac
exit 0
`);
    const res = run();
    // Must exit 0 even when gh pr create fails — push must not be blocked.
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toMatch(/pr create/);
    expect(res.stderr).toMatch(/gh pr create failed/);
  });

  it('refuses branch names with unsafe characters', () => {
    setupRepo(['src/foo.ts']);
    writeFakeGh(`exit 0`);
    // Use AUTO_PR_BRANCH to smuggle a bad name (git itself would reject spaces).
    const res = run({ AUTO_PR_BRANCH: 'feat with spaces' });
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toMatch(/pr create/);
    expect(res.stderr).toMatch(/unsafe|safe pattern/i);
  });

  it('skips when the upstream remote is missing', () => {
    setupRepo(['src/foo.ts']);
    execSync('git remote remove upstream', { cwd: repoDir });
    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toMatch(/pr list/);
    expect(log).not.toMatch(/pr create/);
    expect(res.stderr).toMatch(/No 'upstream' remote/);
  });

  it('warns but proceeds when branch is behind upstream main', () => {
    setupRepo(['scripts/something.sh']);
    // Add a new commit to upstream/main so our feature branch is "behind".
    const tmpClone = join(tmpRoot, 'upstream-worktree');
    execSync(`git clone "${upstreamBare}" "${tmpClone}"`, { stdio: 'ignore' });
    execSync('git checkout main', { cwd: tmpClone, stdio: 'ignore' });
    execSync('git config user.email up@example.com', { cwd: tmpClone });
    execSync('git config user.name Upstream', { cwd: tmpClone });
    execSync('git config commit.gpgsign false', { cwd: tmpClone });
    writeFileSync(join(tmpClone, 'UP.md'), 'upstream advanced\n');
    execSync('git add UP.md', { cwd: tmpClone });
    execSync('git commit -m "upstream new commit"', { cwd: tmpClone });
    execSync('git push origin main', { cwd: tmpClone });
    // Refresh the test repo's upstream ref to see the new commit.
    execSync('git fetch upstream main', { cwd: repoDir, stdio: 'ignore' });

    writeFakeGh(`
case "$1" in
  auth) exit 0 ;;
  pr)
    case "$2" in
      list)   echo ""; exit 0 ;;
      create) exit 0 ;;
    esac ;;
esac
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/behind upstream/);
    const log = readFileSync(ghLog, 'utf8');
    // Still opens the PR — the behind check is a warning only.
    expect(log).toMatch(/pr create/);
  });

  it('skips when on the base branch itself', () => {
    setupRepo(['src/foo.ts']);
    // Back to main — no feature branch context.
    git('checkout main');
    writeFakeGh(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toMatch(/pr (list|create)/);
    expect(res.stderr).toMatch(/base branch/i);
  });
});
