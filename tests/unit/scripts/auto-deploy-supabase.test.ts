import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';

// Integration test for scripts/auto-deploy-supabase.sh. We build a small git
// repo in tmp, make a pre-merge commit, then fast-forward to a post-merge
// state that emulates a PR landing. `ORIG_HEAD` is set by hand to the
// pre-merge ref so the script's `git diff ORIG_HEAD HEAD` mirrors what git's
// real merge would produce. A fake `supabase` binary on PATH records every
// invocation so we can assert deploys.

const scriptPath = resolve(__dirname, '../../../scripts/auto-deploy-supabase.sh');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('scripts/auto-deploy-supabase.sh', () => {
  let tmpRoot: string;
  let repoDir: string;
  let fakeBin: string;
  let supabaseLog: string;

  function git(args: string) {
    execSync(`git ${args}`, { cwd: repoDir, stdio: 'ignore' });
  }

  function writeFile(rel: string, body: string) {
    const full = join(repoDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }

  // Fresh git repo on `main` with one commit. Returns SHA of that commit.
  function initRepo(): string {
    execSync(`git init "${repoDir}"`, { stdio: 'ignore' });
    git('config user.email test@example.com');
    git('config user.name Test');
    git('config commit.gpgsign false');
    writeFile('README.md', 'init\n');
    git('add README.md');
    git('commit -m init');
    git('branch -M main');
    return execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
  }

  // Make a commit on main and set ORIG_HEAD to the previous tip — mimics
  // the post-merge hook state.
  function commitAndSetOrigHead(pre: string, changes: Record<string, string>, deletions: string[] = []) {
    for (const [p, body] of Object.entries(changes)) {
      writeFile(p, body);
      git(`add "${p}"`);
    }
    for (const d of deletions) {
      git(`rm -r "${d}"`);
    }
    git('commit -m "merge: apply"');
    execSync(`git update-ref ORIG_HEAD ${pre}`, { cwd: repoDir });
  }

  function writeFakeSupabase(behavior: string) {
    const path = join(fakeBin, 'supabase');
    const body = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${supabaseLog}"
${behavior}
`;
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  function run(extraEnv: Record<string, string> = {}): RunResult {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    };
    const res = spawnSync('bash', [scriptPath], { cwd: repoDir, env, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-deploy-supabase-'));
    repoDir = join(tmpRoot, 'repo');
    fakeBin = join(tmpRoot, 'bin');
    supabaseLog = join(tmpRoot, 'supabase.log');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(supabaseLog, '');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('deploys the function touched by the merge', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, { 'supabase/functions/ebay-oauth/index.ts': 'export {};\n' });
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toMatch(/functions deploy ebay-oauth/);
    expect(log).toMatch(/--project-ref baidaaansxrfdislmgyx/);
  });

  it('deploys multiple functions and dedupes multi-file changes', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, {
      'supabase/functions/ebay-oauth/index.ts': 'a\n',
      'supabase/functions/ebay-oauth/helpers.ts': 'b\n',
      'supabase/functions/etsy-oauth/index.ts': 'c\n',
    });
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    const ebayDeploys = log.match(/functions deploy ebay-oauth/g) || [];
    const etsyDeploys = log.match(/functions deploy etsy-oauth/g) || [];
    expect(ebayDeploys.length).toBe(1);
    expect(etsyDeploys.length).toBe(1);
  });

  it('skips when merge touches no supabase functions', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, {
      'src/foo.ts': 'bar\n',
      'dashboard/src/page.tsx': 'baz\n',
    });
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toBe('');
  });

  it('skips deploy for functions whose directory was deleted', () => {
    const pre = initRepo();
    // Stage a function on main first so we can delete it in the "merge".
    writeFile('supabase/functions/old-fn/index.ts', 'old\n');
    git('add supabase/functions/old-fn/index.ts');
    git('commit -m "add old-fn"');
    const withOld = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
    commitAndSetOrigHead(withOld, {}, ['supabase/functions/old-fn']);
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    // The function is mentioned by the diff but the directory is gone —
    // no deploy should run.
    expect(log).toBe('');
    expect(res.stderr).toMatch(/no longer exists locally|No supabase function changes/);
  });

  it('continues when one deploy fails', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, {
      'supabase/functions/a/index.ts': 'a\n',
      'supabase/functions/b/index.ts': 'b\n',
    });
    writeFakeSupabase(`
# Fail on the first function, succeed on the second.
if [[ "$3" == "a" ]]; then exit 1; fi
exit 0
`);
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/deploy FAILED/);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toMatch(/functions deploy a/);
    expect(log).toMatch(/functions deploy b/);
  });

  it('skips when supabase CLI is not installed', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, { 'supabase/functions/foo/index.ts': 'x\n' });
    // Clamp PATH to the system bin dirs only — no homebrew, no fakeBin.
    // That keeps git/sed/grep reachable but keeps real supabase out of reach.
    const res = run({ PATH: '/usr/bin:/bin' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/supabase CLI not installed/);
  });

  it('skips when not on main', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, { 'supabase/functions/foo/index.ts': 'x\n' });
    git('checkout -b feature/other');
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toBe('');
    expect(res.stderr).toMatch(/Not on 'main'/);
  });

  it('respects AUTO_DEPLOY_SKIP kill switch', () => {
    const pre = initRepo();
    commitAndSetOrigHead(pre, { 'supabase/functions/foo/index.ts': 'x\n' });
    writeFakeSupabase(`exit 0`);
    const res = run({ AUTO_DEPLOY_SKIP: '1' });
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toBe('');
    expect(res.stderr).toMatch(/AUTO_DEPLOY_SKIP=1/);
  });

  it('rejects path-like function names', () => {
    const pre = initRepo();
    // A path like supabase/functions/../evil/index.ts is impossible via
    // normal git (git normalizes paths) — but defensively we ensure the
    // regex filters anything that starts with a dot or contains a slash
    // at the "name" position. Since `..` can't appear as a real first
    // segment, validate the guard by checking a dotfile directory name.
    commitAndSetOrigHead(pre, { 'supabase/functions/.hidden/index.ts': 'x\n' });
    writeFakeSupabase(`exit 0`);
    const res = run();
    expect(res.status).toBe(0);
    const log = readFileSync(supabaseLog, 'utf8');
    expect(log).toBe('');
    expect(res.stderr).toMatch(/invalid function name|No supabase function changes/);
  });
});
