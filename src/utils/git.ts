import { execFileSync } from 'child_process';
import { basename, resolve } from 'path';

/** Cap every git call so a stuck git can never block the caller (incl. the daemon loop). */
const GIT_TIMEOUT_MS = 5_000;

export type BareReason =
  | 'not_bare'
  | 'git_worktree_flip_restored'
  | 'intentionally_bare_left_untouched'
  | 'restore_failed';

export interface BareCorrection {
  /** core.bare was effectively true at entry. */
  wasBare: boolean;
  /** We wrote core.bare=false AND verified git now sees a usable work tree. */
  corrected: boolean;
  /**
   * Whether the repo is still NOT usable as a work tree after this call. If true,
   * a caller that needs a work tree must REFUSE rather than proceed — it's either a
   * genuinely-bare repo (left untouched) or a restore that didn't take.
   */
  isBare: boolean;
  reason: BareReason;
}

function gitTrim(repoDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Is `repoDir` a genuine working-tree checkout (vs a deliberately-bare repo)?
 *
 * A work-tree repo — main checkout OR a linked worktree — keeps its git dir under a
 * `.git` (so the common-dir's basename is `.git`); a genuinely-bare repo's common-dir
 * IS the repo root. `rev-parse --git-common-dir` reports this regardless of the
 * (corrupt) core.bare flag and works from a subdir, so it's the robust discriminator.
 * (A `repoDir/.git` existence heuristic is fooled by a subdir call, and the
 * `-c core.bare=false` probe doesn't work — git fixes is-inside-work-tree during repo
 * discovery from the STORED flag, before the per-command override applies.)
 *
 * SCOPE: assumes the standard `.git`-named git dir layout (every repo + worktree in
 * this fleet). A work tree created with `git init --separate-git-dir <other>` has a
 * non-`.git` common-dir and would be classed as bare here (left UNHEALED — fail-safe,
 * never corrupted). Out of scope; revisit only if the fleet adopts separate-git-dir.
 */
function looksLikeWorkTree(repoDir: string): boolean {
  const commonDir = gitTrim(repoDir, ['rev-parse', '--git-common-dir']);
  if (commonDir === null) return false;
  return basename(resolve(repoDir, commonDir)) === '.git';
}

/**
 * Self-heal for a git 2.50.1 defect: `git worktree add/remove` can flip
 * `core.bare=true` on a normal working-tree repo. Once bare, every work-tree git
 * operation (status/add/commit) breaks — autoCommit silently aborts and pushes
 * fail — and the bare status reads as an intentional "restructure". The fleet runs
 * multiple worktrees, so it fires on essentially every worktree op until corrected.
 *
 * Restores `core.bare=false` ONLY on a genuine working-tree repo (git itself, with
 * the bad flag overridden, confirms an inside-work-tree). A deliberately-bare repo
 * is left untouched.
 *
 * Pure / never throws / fail-closed: reads the EFFECTIVE flag with git's bool
 * parser, and after writing false it VERIFIES that git now reports a usable work
 * tree — not merely that the config string changed. If the bad value lived in a
 * scope the write didn't target (per-worktree config), or the post-write read
 * fails/times out, the effective state is not provably healed, so it reports
 * `isBare: true` / `restore_failed` rather than claim a fix it didn't make. A
 * self-heal must never lie about having healed. Logging is left to callers (so the
 * periodic daemon backstop can de-dup).
 */
export function ensureNotBare(repoDir: string): BareCorrection {
  // Effective flag via git's bool parser (handles true/yes/on/1/case;
  // unset / parse-error / non-repo → null → treat as not bare and bail).
  const before = gitTrim(repoDir, ['config', '--type=bool', '--get', 'core.bare']);
  if (before !== 'true') {
    return { wasBare: false, corrected: false, isBare: false, reason: 'not_bare' };
  }

  // Only heal a genuine (mis-flagged) work tree; never flip a deliberately-bare repo.
  if (!looksLikeWorkTree(repoDir)) {
    return { wasBare: true, corrected: false, isBare: true, reason: 'intentionally_bare_left_untouched' };
  }

  // Attempt the repair (never throw — a self-heal that crashes the caller is worse
  // than the bug). `git config` (local) targets the repo's config regardless of subdir.
  try {
    execFileSync('git', ['config', 'core.bare', 'false'], {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return { wasBare: true, corrected: false, isBare: true, reason: 'restore_failed' };
  }

  // VERIFY-after-write, fail-closed: require the effective flag to be EXACTLY "false"
  // (a null/error read must NOT pass) AND that git now sees a usable work tree. The
  // work-tree check closes the case where the write hit the wrong config scope (or a
  // pathologically-bare repo) — core.bare may read false yet the repo still isn't
  // usable. Both must hold, or it's restore_failed.
  const after = gitTrim(repoDir, ['config', '--type=bool', '--get', 'core.bare']);
  const usable = gitTrim(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (after !== 'false' || usable !== 'true') {
    return { wasBare: true, corrected: false, isBare: true, reason: 'restore_failed' };
  }

  return { wasBare: true, corrected: true, isBare: false, reason: 'git_worktree_flip_restored' };
}
