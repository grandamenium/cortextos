import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

/**
 * Write the active WRDROBE branch to the Mini autopull config file.
 *
 * The Mini metro-server `wrdrobe-autopull.sh` reads `~/wrdrobe-branch.conf`
 * to know which branch to track in `/Users/gabemacmini/wrdrobe-metro`.
 * Tapping a Telegram instruction like "switch metro to <branch>" ends in a
 * call to this command (typically issued by cardinal's session handler).
 *
 * Validates that the branch exists on the WRDROBE GitHub remote BEFORE
 * writing — a typo'd branch name would otherwise leave the autopull
 * pointing at a non-existent ref and break the Mini until manually fixed.
 *
 * The remote URL + conf path are env-configurable for testability + future
 * proofing:
 *   CTX_WRDROBE_REPO_URL   default `git@github.com:Wrdrobe/wrdrobe.git`
 *   CTX_WRDROBE_BRANCH_CONF default `~/wrdrobe-branch.conf`
 */

export type SetWrdrobeBranchResult =
  | { kind: 'noop'; branch: string }
  | { kind: 'changed'; from: string | null; to: string };

const DEFAULT_REPO_URL = 'git@github.com:Wrdrobe/wrdrobe.git';
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function defaultConfPath(): string {
  return join(homedir(), 'wrdrobe-branch.conf');
}

/** Lightweight branch-name validation. Rejects empty, `-`-prefixed (arg
 *  injection), `..`-containing (path-traversal-adjacent), and anything
 *  outside the conservative `[A-Za-z0-9._/-]` set. The `git ls-remote`
 *  step later is the canonical truth — this is just a fast pre-check. */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (branch.startsWith('-')) return false;
  if (branch.includes('..')) return false;
  return SAFE_BRANCH_RE.test(branch);
}

/** Check the branch exists on the remote. Returns true if `git ls-remote
 *  --heads <url> <branch>` produces any output. Returns false on no-such-
 *  branch OR on git error (network / auth / unknown remote) — caller treats
 *  both as "do not write the conf file." */
export function branchExistsOnRemote(branch: string, repoUrl: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['ls-remote', '--heads', '--exit-code', repoUrl, branch],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 15_000 },
    );
    // --exit-code makes git exit non-zero (caught by catch below) if no
    // refs match, so any successful return means the branch exists.
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function readCurrentBranch(confPath: string): string | null {
  if (!existsSync(confPath)) return null;
  try {
    const raw = readFileSync(confPath, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Set the Mini-autopull branch. Returns a typed result so the CLI layer can
 * render an appropriate Telegram-friendly message back to the caller.
 *
 * `options.repoUrl` and `options.confPath` are primarily for tests; both
 * accept env-var overrides via `CTX_WRDROBE_REPO_URL` /
 * `CTX_WRDROBE_BRANCH_CONF` at the CLI layer.
 */
export function setWrdrobeBranch(
  branch: string,
  options?: {
    repoUrl?: string;
    confPath?: string;
    /** Optional override for the remote-existence check. Lets tests pass
     *  a stub without going to the real `git ls-remote`. Defaults to the
     *  exported `branchExistsOnRemote`. */
    branchExists?: (branch: string, repoUrl: string) => boolean;
  },
): SetWrdrobeBranchResult {
  if (!isValidBranchName(branch)) {
    throw new Error(
      `Invalid branch name: ${JSON.stringify(branch)}. ` +
        `Branch names must match [A-Za-z0-9._/-], not start with '-', and not contain '..'.`,
    );
  }

  const repoUrl = options?.repoUrl ?? DEFAULT_REPO_URL;
  const confPath = options?.confPath ?? defaultConfPath();
  const checkExists = options?.branchExists ?? branchExistsOnRemote;

  if (!checkExists(branch, repoUrl)) {
    throw new Error(
      `Branch '${branch}' not found on remote ${repoUrl}. ` +
        `Check the spelling and that the branch has been pushed.`,
    );
  }

  const current = readCurrentBranch(confPath);
  if (current === branch) {
    return { kind: 'noop', branch };
  }

  // atomicWriteSync appends a trailing newline so the on-disk file is
  // `<branch>\n` — readable via `cat` + shell `read` grabs the value
  // cleanly.
  atomicWriteSync(confPath, branch);
  return { kind: 'changed', from: current, to: branch };
}
