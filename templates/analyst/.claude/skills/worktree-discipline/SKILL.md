---
name: worktree-discipline
description: Shared-repo multi-agent contamination rules. Trigger before any git checkout, edit, commit, or push in the framework repos. Use a per-agent worktree, never the canonical tree.
---

# Worktree discipline (shared-repo coordination)

The framework repo at `$CTX_FRAMEWORK_ROOT` (and any sibling shared repos the agent operates on — e.g. `$CTX_JARVIS_ROOT`, resolved per-machine) are **shared working trees** — multiple agents and the user may be operating in them at any moment. Branch operations there silently corrupt other agents' uncommitted state. See `.claude/rules/code-quality/same-repo-multi-agent-checkout-contamination.md`.

**Never edit, commit, or checkout feature branches in the canonical tree.** Use a per-agent worktree.

## Convention

`~/cortextos-worktrees/<your-agent-name>/<branch>` (or `~/jarvis-worktrees/...`).

## Workflow when starting any non-trivial code task

```bash
# 1. Fetch from canonical (read-only ops there are fine)
cd $CTX_FRAMEWORK_ROOT
git fetch origin main

# 2. Create your worktree on a fresh branch off origin/main
git worktree add ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name> -b <branch-name> origin/main

# 3. cd in and work there for the entire feature lifecycle
cd ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name>
# ... edit, build, test, commit, push, PR, evaluator cycle ...

# 4. After PR is merged, clean up
cd $CTX_FRAMEWORK_ROOT
git worktree remove ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name>
```

The canonical tree is read-only for you — `git fetch`, `git pull origin main`, `git log`, `git status` against main are fine; everything else (checkout, edit, commit, push) goes through your worktree.

## Fresh-worktree gotcha: install + build before tests

A fresh worktree has neither `node_modules/` nor a `dist/` build, and `cortextos` is **not** an npm workspace — so a root `npm install` does NOT install the `dashboard/` package's deps. Skipping either step makes `npm run prepush` fail with confusing "pre-existing test failures" that don't reproduce on `main`.

Always run all three before testing or `prepush`:

```bash
cd ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch>
npm install                    # root deps
(cd dashboard && npm install)  # dashboard deps — separate package, easy to forget
npm run build                  # produces dist/cli.js used by integration tests
```

Failure signatures, if any step is skipped:

- **Missing `dashboard/node_modules/`** — 11 test files fail with `ERR_MODULE_NOT_FOUND` on `next/server` or `better-sqlite3`: `tests/integration/phase4-dashboard-backtest.test.ts`, `tests/integration/phase4-performance.test.ts`, `tests/integration/phase5-user-journeys.test.ts`, `tests/integration/phase5-e2e-simulation.test.ts`, plus the 7 `dashboard/src/**/__tests__/*` files.
- **Missing `dist/cli.js`** — 3 test files fail with `CLI entry missing ... run npm run build first`: `tests/integration/context-update-cli.test.ts`, `tests/integration/hook-context-status-migration.test.ts`, `tests/unit/hooks/hook-worktree-warn.test.ts`.

Do not reach for `--no-verify` — run the missing install/build instead.

## Recovery

- Worktree dir already exists from a prior PR: `git worktree list` to inspect, `git worktree remove --force <path>` if stale.
- Same branch name taken by another agent: pick a different name.
- After daemon restart, ALWAYS `git branch --show-current` immediately before commit — restarts reset implicit branch state and prior commits can land on a sibling agent's branch silently.

## Why this matters

Two distinct contamination shapes the rule prevents:
1. **Branch-checkout discards uncommitted work.** Agent A is mid-edit on branch X; agent B `git checkout Y` either fails or carries A's edits onto Y silently.
2. **Daemon-restart respawns on wrong branch.** Session loses implicit branch state; subsequent commits land on whatever was checked out at restart time, not what the agent intended.
