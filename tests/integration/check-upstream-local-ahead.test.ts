/**
 * tests/integration/check-upstream-local-ahead.test.ts — regression guard for #31.
 *
 * `checkUpstream` reported `updates_available` whenever HEAD != upstream/main,
 * even when the only difference was LOCAL commits upstream doesn't have. The
 * upstream-sync cron then fired on local-only work. It must report
 * `updates_available` only when upstream is genuinely AHEAD, and `local_ahead`
 * (or `up_to_date`) otherwise.
 *
 * Builds a real git fixture: a working repo + a bare "upstream" remote, then
 * drives each ahead/behind/equal case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { checkUpstream } from '../../src/bus/metrics.js';

let work: string;
let bare: string;

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}
function commit(file: string, body: string, msg: string): void {
  writeFileSync(join(work, file), body);
  git(work, 'add -A');
  git(work, `commit -q -m "${msg}"`);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'check-upstream-work-'));
  bare = mkdtempSync(join(tmpdir(), 'check-upstream-bare-'));
  git(work, 'init -q -b main');
  git(work, 'config user.email t@example.com');
  git(work, 'config user.name tester');
  git(work, 'config commit.gpgsign false');
  commit('README.md', 'base', 'base');
  git(bare, 'init -q --bare');
  git(work, `remote add upstream "${bare}"`);
  git(work, 'push -q upstream HEAD:main'); // bare/main = base
});

afterEach(() => {
  for (const d of [work, bare]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('checkUpstream ahead/behind classification (#31)', () => {
  it('reports local_ahead when HEAD has commits upstream does not', () => {
    commit('local.md', 'local-only', 'local-only-commit'); // HEAD = base + 1, upstream/main = base
    const r = checkUpstream(work, { apply: false });
    expect(r.status).toBe('local_ahead');
    expect(r.commits).toBe(1);
  });

  it('reports up_to_date when HEAD equals upstream/main', () => {
    const r = checkUpstream(work, { apply: false });
    expect(r.status).toBe('up_to_date');
  });

  it('still reports updates_available when upstream is genuinely ahead', () => {
    commit('upstream.md', 'newer', 'upstream-commit');
    git(work, 'push -q upstream HEAD:main'); // bare/main = base + 1
    git(work, 'reset -q --hard HEAD~1');     // local back to base → now behind
    const r = checkUpstream(work, { apply: false });
    expect(r.status).toBe('updates_available');
    expect(r.commits).toBe(1);
  });

  it('reports updates_available when branches diverge (HEAD ahead AND behind)', () => {
    // Push an upstream-only commit, rewind local back to base, then add a
    // DIFFERENT local-only commit. Now HEAD and upstream/main each carry a
    // commit the other lacks. The `commitCount === 0` shortcut must NOT fire —
    // upstream genuinely has a commit we lack, so updates are available. (#31)
    commit('upstream.md', 'newer', 'upstream-commit');
    git(work, 'push -q upstream HEAD:main'); // bare/main = base + upstream-commit
    git(work, 'reset -q --hard HEAD~1');     // local back to base
    commit('local.md', 'local-only', 'local-only-commit'); // HEAD = base + local-commit
    const r = checkUpstream(work, { apply: false });
    expect(r.status).toBe('updates_available');
    expect(r.commits).toBe(1); // one upstream commit we lack, despite being diverged
  });
});
