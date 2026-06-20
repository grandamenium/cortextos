import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

export type WorktreeRunFn = (args: string[], opts?: { cwd?: string }) => string;

export interface EnsureWorktreeOptions {
  /**
   * Directory where per-agent worktrees are placed. Defaults to
   * `<repoPath>/.cortextos-worktrees`. Each agent's worktree is rooted at
   * `<baseDir>/<agentName>`.
   */
  baseDir?: string;
  /**
   * Override for the git runner. Production uses `execFileSync('git', args)`;
   * tests inject a mock so no real git commands run. Must return stdout as a
   * string and throw on non-zero exit.
   */
  runGit?: WorktreeRunFn;
}

export interface WorktreeResult {
  /** Absolute path to the worktree's working tree. */
  path: string;
  /** Branch that the worktree has checked out. */
  branch: string;
  /** True when this call created the worktree; false when it pre-existed. */
  created: boolean;
}

/**
 * Provision (or attach to) a git worktree dedicated to a single agent.
 *
 * Why this exists: multiple agents sharing one working copy of phytomedic-saas
 * causes branch contamination — agent A's `git checkout` silently strands
 * agent B's uncommitted edits on the wrong branch. Per-agent worktrees give
 * each agent its own checked-out copy with its own HEAD, eliminating the race
 * without forcing a separate repository clone per agent.
 *
 * Idempotent: if the target path is already registered as a worktree of the
 * same repo and on the requested branch, returns the existing path. If the
 * path is registered but on a different branch, throws (the caller must
 * decide whether to switch it or pick a new agent name).
 */
export function ensureWorktree(
  repoPath: string,
  agentName: string,
  branch: string,
  options: EnsureWorktreeOptions = {}
): WorktreeResult {
  if (!repoPath || !isAbsolute(repoPath)) {
    throw new Error(`ensureWorktree: repoPath must be absolute (got ${repoPath})`);
  }
  if (!agentName || /[\/\\\s]/.test(agentName)) {
    throw new Error(`ensureWorktree: agentName must be a slug without slashes/spaces (got "${agentName}")`);
  }
  if (!branch) {
    throw new Error('ensureWorktree: branch is required');
  }
  if (!existsSync(repoPath)) {
    throw new Error(`ensureWorktree: repoPath does not exist: ${repoPath}`);
  }

  const runGit: WorktreeRunFn = options.runGit || ((args, opts) =>
    execFileSync('git', args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString());

  const baseDir = options.baseDir
    ? (isAbsolute(options.baseDir) ? options.baseDir : resolve(repoPath, options.baseDir))
    : join(repoPath, '.cortextos-worktrees');
  const targetPath = join(baseDir, agentName);

  const existing = listWorktrees(runGit, repoPath);
  const match = existing.find((w) => w.path === targetPath);
  if (match) {
    if (match.branch && match.branch !== branch) {
      throw new Error(
        `ensureWorktree: worktree at ${targetPath} is on branch "${match.branch}", not "${branch}". ` +
          `Resolve manually (git -C ${targetPath} checkout ${branch}) or pick a different agentName.`
      );
    }
    return { path: targetPath, branch, created: false };
  }

  if (existsSync(targetPath)) {
    throw new Error(
      `ensureWorktree: ${targetPath} already exists on disk but is not a registered worktree. ` +
        `Remove it or run \`git worktree prune\` before retrying.`
    );
  }

  const branchExists = isBranchKnown(runGit, repoPath, branch);
  const addArgs = branchExists
    ? ['worktree', 'add', targetPath, branch]
    : ['worktree', 'add', '-b', branch, targetPath];
  runGit(addArgs, { cwd: repoPath });

  return { path: targetPath, branch, created: true };
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function listWorktrees(runGit: WorktreeRunFn, repoPath: string): WorktreeEntry[] {
  let raw: string;
  try {
    raw = runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  } catch {
    return [];
  }
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
    current = {};
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return entries;
}

function isBranchKnown(runGit: WorktreeRunFn, repoPath: string, branch: string): boolean {
  try {
    runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}
