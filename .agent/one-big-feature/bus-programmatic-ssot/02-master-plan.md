# OBF: Bus as Programmatic SSOT (roadmap item #8, Josh-approved 2026-07-06)

## Goal
Every planning framework WRITES to the bus programmatically so "what is open" is always ONE live bus query across all frameworks + agents. Roadmaps/PHASES.md become VIEWS of the bus, not rot-prone source docs. Bidirectional: auto-OPEN and smart auto-CLOSE (Josh: "don't have 100s pending").

## Scope (repo: ~/code/cortextos)
### A. Auto-OPEN hooks
- M2C1: each phase (PRD/research/discovery/plan/specs/execution) -> bus task/subtask at phase start.
- OBF: slug -> bus epic; each 03-specs/*.md -> child task at plan time (tie into existing gate-codexer-planning.sh).
- Entry paths -> task: cron finding (partly done), Telegram/comms ask, codexer dispatch.

### B. Smart auto-CLOSE (the critical half)
- PR landed -> close linked task (link via slug/branch in task meta).
- OBF spec landed + branch deleted -> close epic children.
- M2C1 phase regression-green -> close phase task.
- codexer review PASS + PR opened -> advance status.
- task-done-detector hook (ALREADY LIVE) -> close on Josh "done".
- STALENESS REAPER cron: task pending >N days + zero activity -> auto-archive + flag ONCE, never resurface. Also drains the existing ~17k task-file backlog.

### C. Status = generated
- `cortextos bus list-tasks` (filtered by epic) is the SSOT. Any status doc is generated from it, never hand-typed.

## Split
- Larry writes: specs (this dir), skill-instruction edits (M2C1/OBF SKILL.md), reaper cron def.
- Codexer writes: .ts hook code (PR-event -> close, dispatch -> open, task meta linkage) under GATE.

## Open design Qs
- Task<->PR linkage key (slug in task title? meta field?).
- Reaper N-days threshold + archive vs delete.
- Backlog drain: one-time reaper pass on 17k existing (staging-first? it's task json, low risk, but confirm).

## Lessons Consulted
- **build-from-existing, don't rebuild** (Josh ×2 this session): reuse compact-tasks/check-stale-tasks/complete-task/fleet-reconcile; categorization is a DERIVED read-layer, not new storage or a backfill of 210 files.
- **fix-once-dont-narrate recurring bugs**: system-vs-build noise is deterministic via created_by prefix (transcript-scanner-/comms-check-), not title guessing — encode once in classifyTask.
- **verify live state before claiming** (MUTABLE-FACT=HYPOTHESIS): the "229 cron noise" was a wrong guess; actual = 1 cron, ~25 system-spawned, rest build. Spec built on the verified breakdown, not the guess.
- **scope-lock / no down-classification**: single feature, one repo, project field already on the model — OBF is correct, no schema change.

## REVISION 2026-07-06 (Josh: build from existing, don't rebuild)
CLOSE machinery ALREADY EXISTS — do NOT rewrite:
- `bus compact-tasks` (archive completed >N days, skip blockers), `bus archive-tasks` (>7d), `bus check-stale-tasks` (in_progress>2h/pending>24h/overdue), `bus complete-task`, `bus fleet-reconcile`, `bus check-deps` (blocked_by). Source: src/bus/task.ts, src/bus/reconcile.ts, src/cli/bus.ts.
Revised #8 = WIRING only:
1. Reaper CRON: schedule check-stale-tasks + archive-tasks/compact-tasks (drains 17k backlog, keeps clean). Mostly a cron def — Larry can write.
2. OPEN hooks: M2C1 phase-start + OBF spec-create -> bus create-task (small codexer edit in skill/hook).
3. PR-event -> complete-task linkage via slug/branch in task meta (small codexer edit).
Net: reuse existing close primitives; only add the timer + the open-triggers + PR-close linkage.
