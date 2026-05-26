import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: (...args: Parameters<typeof actual.existsSync>) => existsMock(...args) };
});

const { ensureWorktree } = await import('../../../src/daemon/worktree-manager.js');

type RunnerCall = { args: string[]; cwd?: string };

interface RunnerScript {
  /** match by args.join(' ') prefix; first match wins */
  match: string;
  /** stdout to return, or "THROW" to simulate non-zero exit */
  result: string;
}

function makeRunner(script: RunnerScript[]) {
  const calls: RunnerCall[] = [];
  const fn = (args: string[], opts?: { cwd?: string }) => {
    calls.push({ args, cwd: opts?.cwd });
    const joined = args.join(' ');
    const entry = script.find((s) => joined.startsWith(s.match));
    if (!entry) throw new Error(`unscripted git call: ${joined}`);
    if (entry.result === 'THROW') throw new Error('non-zero exit');
    return entry.result;
  };
  return { fn, calls };
}

describe('ensureWorktree', () => {
  beforeEach(() => {
    existsMock.mockReset();
  });

  it('rejects relative repoPath', () => {
    expect(() => ensureWorktree('relative/path', 'agent', 'branch')).toThrow(/absolute/);
  });

  it('rejects agentName with slashes or spaces', () => {
    expect(() => ensureWorktree('/repo', 'bad name', 'branch')).toThrow(/slug/);
    expect(() => ensureWorktree('/repo', 'bad/name', 'branch')).toThrow(/slug/);
  });

  it('rejects empty branch', () => {
    expect(() => ensureWorktree('/repo', 'agent', '')).toThrow(/branch is required/);
  });

  it('throws when repoPath does not exist', () => {
    existsMock.mockReturnValue(false);
    expect(() => ensureWorktree('/missing', 'agent', 'br', { runGit: () => '' })).toThrow(/does not exist/);
  });

  it('creates a new worktree with existing branch (no -b flag)', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
      { match: 'show-ref --verify --quiet refs/heads/feature', result: '' },
      { match: 'worktree add /repo/.cortextos-worktrees/alice feature', result: '' },
    ]);

    const result = ensureWorktree('/repo', 'alice', 'feature', { runGit: fn });

    expect(result).toEqual({
      path: '/repo/.cortextos-worktrees/alice',
      branch: 'feature',
      created: true,
    });
    expect(calls[2].args).toEqual(['worktree', 'add', '/repo/.cortextos-worktrees/alice', 'feature']);
  });

  it('creates a new branch with -b when branch is unknown', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
      { match: 'show-ref --verify --quiet', result: 'THROW' },
      { match: 'worktree add -b', result: '' },
    ]);

    const result = ensureWorktree('/repo', 'bob', 'claude/bob', { runGit: fn });

    expect(result.created).toBe(true);
    expect(calls[2].args).toEqual([
      'worktree',
      'add',
      '-b',
      'claude/bob',
      '/repo/.cortextos-worktrees/bob',
    ]);
  });

  it('returns created:false when worktree already registered on the right branch', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const porcelain = [
      'worktree /repo',
      'branch refs/heads/main',
      '',
      'worktree /repo/.cortextos-worktrees/alice',
      'branch refs/heads/feature',
      '',
    ].join('\n');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: porcelain },
    ]);

    const result = ensureWorktree('/repo', 'alice', 'feature', { runGit: fn });

    expect(result).toEqual({
      path: '/repo/.cortextos-worktrees/alice',
      branch: 'feature',
      created: false,
    });
    // only the list call should have happened; no add
    expect(calls).toHaveLength(1);
  });

  it('throws when an existing worktree is on a different branch', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const porcelain = [
      'worktree /repo/.cortextos-worktrees/alice',
      'branch refs/heads/other-branch',
      '',
    ].join('\n');
    const { fn } = makeRunner([
      { match: 'worktree list --porcelain', result: porcelain },
    ]);

    expect(() => ensureWorktree('/repo', 'alice', 'feature', { runGit: fn })).toThrow(
      /on branch "other-branch", not "feature"/
    );
  });

  it('throws when the target path exists on disk but is not a registered worktree', () => {
    existsMock.mockImplementation((p: string) =>
      p === '/repo' || p === '/repo/.cortextos-worktrees/zombie'
    );
    const { fn } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
    ]);

    expect(() => ensureWorktree('/repo', 'zombie', 'br', { runGit: fn })).toThrow(
      /already exists on disk but is not a registered worktree/
    );
  });

  it('honors a relative baseDir by resolving it against repoPath', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
      { match: 'show-ref', result: '' },
      { match: 'worktree add', result: '' },
    ]);

    ensureWorktree('/repo', 'carol', 'br', { runGit: fn, baseDir: 'agents/worktrees' });

    expect(calls[2].args).toEqual([
      'worktree',
      'add',
      '/repo/agents/worktrees/carol',
      'br',
    ]);
  });

  it('honors an absolute baseDir as-is', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
      { match: 'show-ref', result: '' },
      { match: 'worktree add', result: '' },
    ]);

    ensureWorktree('/repo', 'dave', 'br', { runGit: fn, baseDir: '/var/worktrees' });

    expect(calls[2].args).toEqual(['worktree', 'add', '/var/worktrees/dave', 'br']);
  });

  it('passes cwd: repoPath to every git invocation', () => {
    existsMock.mockImplementation((p: string) => p === '/repo');
    const { fn, calls } = makeRunner([
      { match: 'worktree list --porcelain', result: '' },
      { match: 'show-ref', result: '' },
      { match: 'worktree add', result: '' },
    ]);

    ensureWorktree('/repo', 'eve', 'br', { runGit: fn });

    for (const c of calls) expect(c.cwd).toBe('/repo');
  });
});
