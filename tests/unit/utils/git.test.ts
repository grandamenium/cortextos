import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureNotBare } from '../../../src/utils/git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('ensureNotBare — git 2.50.1 worktree-flip self-heal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-git-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no-ops on a non-git directory (never throws)', () => {
    expect(ensureNotBare(dir)).toEqual({
      wasBare: false, corrected: false, isBare: false, reason: 'not_bare',
    });
  });

  it('no-ops on a normal work-tree repo (core.bare false)', () => {
    git(dir, 'init', '-q');
    const r = ensureNotBare(dir);
    expect(r.wasBare).toBe(false);
    expect(r.isBare).toBe(false);
    expect(r.reason).toBe('not_bare');
  });

  it('★ restores core.bare=false on a work-tree repo mis-flagged bare (the bug)', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.bare', 'true'); // simulate the worktree-flip
    expect(git(dir, 'config', '--get', 'core.bare')).toBe('true');

    const r = ensureNotBare(dir);

    expect(r).toEqual({
      wasBare: true, corrected: true, isBare: false, reason: 'git_worktree_flip_restored',
    });
    expect(git(dir, 'config', '--get', 'core.bare')).toBe('false');
  });

  it('★ verify-after-write: reports not-bare ONLY when the effective value is really false', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.bare', 'true');
    const r = ensureNotBare(dir);
    // Re-read independently — the helper must not claim success on a silent no-op.
    expect(git(dir, 'config', '--type=bool', '--get', 'core.bare')).toBe('false');
    expect(r.isBare).toBe(false);
  });

  it('handles non-canonical bool values via --type=bool (on/1/yes → still treated as bare)', () => {
    for (const truthy of ['on', '1', 'yes']) {
      const d = mkdtempSync(join(tmpdir(), 'cortextos-git-bool-'));
      try {
        git(d, 'init', '-q');
        git(d, 'config', 'core.bare', truthy);
        const r = ensureNotBare(d);
        expect(r.corrected, `core.bare=${truthy} should be detected + restored`).toBe(true);
        expect(git(d, 'config', '--type=bool', '--get', 'core.bare')).toBe('false');
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('★ leaves an INTENTIONALLY-bare repo untouched (git confirms no work tree)', () => {
    git(dir, 'init', '--bare', '-q'); // a real bare repo: dir IS the git dir
    expect(git(dir, 'config', '--get', 'core.bare')).toBe('true');

    const r = ensureNotBare(dir);

    expect(r).toEqual({
      wasBare: true, corrected: false, isBare: true, reason: 'intentionally_bare_left_untouched',
    });
    expect(git(dir, 'config', '--get', 'core.bare')).toBe('true'); // STAYS bare
  });

  it('★ heals from a SUBDIRECTORY of a mis-flagged work-tree repo (not misclassified)', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.bare', 'true');
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    const r = ensureNotBare(sub); // called on a subdir, not the root

    expect(r.corrected).toBe(true);
    expect(r.isBare).toBe(false);
    expect(git(dir, 'config', '--type=bool', '--get', 'core.bare')).toBe('false');
  });

  it('after correction, work-tree git ops succeed again', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.bare', 'true');
    expect(() => git(dir, 'status', '--porcelain')).toThrow(); // bare rejects the op

    ensureNotBare(dir);

    expect(() => git(dir, 'status', '--porcelain')).not.toThrow();
  });

  it('is idempotent — a second call after correction does nothing', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.bare', 'true');
    ensureNotBare(dir);
    expect(ensureNotBare(dir)).toEqual({
      wasBare: false, corrected: false, isBare: false, reason: 'not_bare',
    });
  });
});
