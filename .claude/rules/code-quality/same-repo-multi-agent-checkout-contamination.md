---
domain: [git, fleet-coordination, multi-agent]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Same-repo multi-agent contamination: branch checkout silently discards another agent's uncommitted work

**When multiple agents share a single git working tree, any agent's branch checkout silently discards (or carries forward unexpectedly) other agents' uncommitted work.** Class-of-trap is distinct from cross-fleet contamination — there it's another fleet's agents touching our tree; here it's our-fleet's-agents-on-our-shared-repo. Same matrix shape, different ownership boundary.

The trap surfaces when:
- Agent A is mid-implementation on branch X with uncommitted edits to files that differ between X and Y.
- Agent B (unaware of A's work) does `git checkout Y` (or `git checkout -b new-branch Y`), git either refuses (if conflicting) or carries A's edits onto the new branch silently.
- Either outcome wastes A's time: refusal blocks B; carry-over scope-mixes A's work into B's PR.

## Pattern fix

Four options, in order of preference:

1. **Dedicated git worktrees per agent on shared repos.** `git worktree add ../repo-engineer feat/x` gives engineer its own working tree under the same .git. Branch checkouts in one worktree don't affect another. Best discipline; one-time setup cost.

2. **Coordinate checkouts via inbox messages.** Before any branch switch, agent posts a `branch_checkout_lock` inbox message; other agents check before their own switches. Lower setup cost but requires every agent to honor the protocol.

3. **Commit-before-checkout discipline.** Every agent commits (or at minimum stashes with descriptive name) ALL working-tree changes before any branch operation. WIP commits are fine — squash before PR. Lowest setup cost, requires every agent's discipline.

4. **Verify-current-branch discipline before every commit AND after every session restart.** `git branch --show-current` is a one-line check that catches the daemon-restart-respawned-on-wrong-branch variant of this trap. The mechanism: agent A creates a feature branch, daemon-restart happens, agent A's session respawns with the working tree checked out to whatever branch the directory had at restart-time (which may be a sibling agent's branch, NOT agent A's intended branch). Subsequent commits land silently on the wrong branch. The fix: `git branch --show-current` immediately after any session restart AND immediately before any commit. The cost is one shell command per commit; the benefit is preventing cross-branch contamination of completed work.

## Rule of thumb

A shared git working tree is a shared mutable resource — the same coordination rules apply as to any concurrent-write data structure. Either partition it (worktrees), lock it (inbox protocol), or serialize via discipline (commit-before-checkout + verify-current-branch). Picking none is the failure mode. Daemon-restart is a hidden trap-trigger because it resets implicit working-tree state without any visible cue; the verify-current-branch check is cheap insurance against it.

## Source incident

Two incidents on 2026-05-08, both confirming the rule in real-time:

1. **Engineer's BL-003 phase 1 edits affected by analyst's branch operation** — analyst branched + checked out for BL-002 on cortextos-fork; engineer's uncommitted BL-003 phase 1 edits (~5 files, 31 passing tests) on the shared working tree were affected. Engineer recovered via `/tmp/bl-003-worktree`, +20 min cost. Captured as the original incident the rule was written from.

2. **Analyst's BL-002 commit landed on fullstack's BL-004 branch** — within the same session that authored this rule, analyst's BL-002 P1+P2 commit landed on `feat/v0.4-engineer-context-discipline-phase-1` (fullstack's BL-004 branch) instead of the intended `chore/code-quality-progressive-disclosure`. Root cause: daemon-restart at 19:36 UTC reset the implicit branch state; analyst never re-verified `git branch --show-current` after the respawn. Self-detected on commit-output-line and recovered via cherry-pick + `reset --hard HEAD~1` on fullstack's branch. Contamination existed only locally for ~2 min, never pushed to remote. Confirms the daemon-restart variant of the trap and motivates the verify-current-branch pattern fix above.

Class is distinct from the 2026-05-08 cross-fleet-contamination rule (jarvis-fleet auto-committing into engineer-D2 branch on the jarvis tree); both rules together cover the full matrix of repo-ownership × fleet-membership × session-restart-state.
