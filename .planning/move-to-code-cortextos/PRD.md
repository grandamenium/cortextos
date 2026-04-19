# PRD — Move cortextos framework into ~/code/

**Status:** Plan only. Not executing until Josh gives go-ahead.
**Created:** 2026-04-13 by frank2
**Last updated:** 2026-04-18 by frank2 (post-upstream-merge audit)
**Branch (when executed):** `feature/relocate-to-code-cortextos` (branch off main after merge/upstream-main-apr17 lands)

## Problem

Framework lives at `~/cortextos/`, sibling of `~/code/`. Josh's mental model: "code lives in `~/code/`". Friction whenever he navigates the filesystem — the framework is the odd one out.

Secondary: a stale `~/cortextos.old/` sits next to it from a prior migration. Confirmed safe to remove — it's missing `installers/` and `state/` (both added after the copy was made). No unique data in it.

## What changed since April 13

**Fleet expanded 4 → 8 agents.** When this was written, only auditos, frank2, sage, and maven were running. Now also running: hunter, larry, muse, sre. Migration downtime affects all 8.

**Upstream merge landed (2026-04-17, commit e6de5c5).** 31 commits from grandamenium/cortextos merged into `merge/upstream-main-apr17`. Includes: new `state/` directory in framework tree, `installers/` directory, zombie-detection improvements, stuck-dialog fixes, narration enforcement, settings validation, parse-failure watcher, and AskUserQuestion freeze guard. Path rewrite in ecosystem.config.js is unaffected — all hardcoded paths still reference `~/cortextos/`.

**Current branch is `merge/upstream-main-apr17`, not main.** Pre-flight gate requires this to land on main first.

**cortextos.old confirmed stale and removable.** `diff <(ls ~/cortextos/) <(ls ~/cortextos.old/)` shows cortextos.old is missing `installers/` and `state/` — it predates both. Safe to delete.

**Major stability fixes shipped (BUG-050 through BUG-086).** Daemon is significantly more stable than when this PRD was written. The move itself carries less risk now.

## Goal

Move `~/cortextos/` → `~/code/cortextos/` with zero data loss and minimum downtime (target < 15 min fleet outage). All 8 agents must come back online automatically and resume work.

## Non-goals

- Splitting orgs/ out to a separate repo (Option C from the earlier convo). Out of scope.
- Moving `~/.cortextos/` runtime state. Stays where it is.
- Moving `~/code/auditos`, `~/code/clearpath`, etc. — those are the repos agents operate on, they already live in `~/code/`.

## Success criteria

1. `pwd` at new location returns `/Users/joshweiss/code/cortextos`.
2. `pm2 list` shows `cortextos-daemon` + `cortextos-dashboard` online with new cwd.
3. `cortextos status --instance cortextos1` returns all 8 agents `running` within 3 min of restart.
4. Each agent responds to a Telegram test ping within 5 min.
5. Dashboard loads at localhost:3000 with fresh data.
6. `git status` in new location is clean, `git log` matches pre-move.
7. `~/cortextos.old/` removed.
8. `~/cortextos/` symlink left behind pointing at new location (remove after 48h if nothing breaks).

## Out-of-scope risks acknowledged

- Claude Code transcript paths under `~/.claude/projects/-Users-joshweiss-cortextos-...` will NOT match new cwd. Transcripts for in-flight sessions keep writing to old paths until each agent hard-restarts. Post-move transcripts go to new escaped path. No code change needed.
- Any open Claude Code session that survives the move will drift. Hard-restart all 8 agents as part of the migration.
- larry uses `claude-opus-4-7` (confirmed running). Budget accordingly — restart will consume a new context.
