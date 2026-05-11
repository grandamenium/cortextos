# Handoff — cortextOS PR-A2 (deferred restructure work)

**Paste the section below as your initial prompt in a new Claude Code session at `/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork`.**

---

## Mission

Pick up the deferred items from PR-A of the cost & context optimization plan: **A3 file deletes + content trims, A5 prose adds, A6 fullstack Opus override note, A8 quality-flag fixes**. The MCP audit (A7) is already done — there are zero MCP servers registered.

This is **PR-A2** — a follow-up to **PR #23** (already merged or about to be). Open a fresh branch off `main`.

## Required reading before starting

1. **The plan** — `docs_sb/issues/ok-so-we-want-snazzy-garden.md`. Read PR-A sections A3, A5, A6, A8. The Risk register at the bottom names the failure modes.
2. **PR #23 status** — `gh pr view 23 --repo saurav-yirifi/sb-cortextos-fork`. If still OPEN, wait for it to merge or rebase your branch after merge. PR-A2 builds on its skills + backup + migration script.
3. **What PR-A already shipped** — read commits `b98f029`, `e52566e`, `a7d4d42`, `a1bf33f`, `9036658` between `main` and `feat/cost-context-optimization-pr-a` if PR-23 is still open. Those landed: configs, 1M-off, backup snapshot, 3 new skills + 3 reference docs, evaluator fixes.
4. **The backup** — `docs_sb/agent-file-backups/2026-05-11-pre-restructure/`. It has 49 files: pre-restructure snapshots of every per-role markdown across `live-fleet/` (the gitignored `orgs/sb-personal/agents/*/`) and `templates/`. Treat this as the source-of-truth for ORIGINAL content; the live + template files you're about to edit will be the post-trim versions.
5. **Code-quality rules** — `.claude/rules/code-quality.md` and the relevant subfiles. Particular attention to:
   - `daemon-side-config-requires-daemon-restart.md` — the trims/deletes you make to live `orgs/*/agents/*/` files take effect immediately, but daemon-side code changes need `pm2 restart cortextos`.
   - `same-repo-multi-agent-checkout-contamination.md` — use a per-agent worktree under `~/cortextos-worktrees/<your-name>/<branch>`. The user has an analyst worktree on `main`; you cannot `git checkout main` in the canonical tree.

## Branch setup

```bash
cd /Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork
git fetch origin main
git worktree add ~/cortextos-worktrees/<your-name>/pr-a2-restructure -b feat/cost-context-optimization-pr-a2 origin/main
cd ~/cortextos-worktrees/<your-name>/pr-a2-restructure
```

## What you're doing (scope summary)

| Item | What it is | Risk |
|---|---|---|
| **A3 — deletes** | Delete `AGENTS.md`, `ONBOARDING.md`, `TOOLS.md` from `templates/{agent,analyst,orchestrator}/` AND `orgs/sb-personal/agents/{boss,analyst,engineer,devops,fullstack}/` | **Breaks ~70 tests** that codify these files. Tests need paired updates. Also requires `src/` code edits — see below. |
| **A3 — trims** | Trim `CLAUDE.md`, `HEARTBEAT.md`, `SOUL.md`, `GUARDRAILS.md` per role to the plan's targets, routing extracted content to the existing skills (`memory-discipline`, `dispatch-protocol`, `worktree-discipline`) and to `templates/EVENT_LOGGING_PROTOCOL.md` | **May break content-keyed tests** in `tests/sprint1-templates.test.ts` (assertions like "CLAUDE.md has first boot check", "GUARDRAILS.md has red flag table", "HEARTBEAT.md has 9 steps"). Preserve those bones. |
| **A5 — prose adds** | After trimming each role's `CLAUDE.md`, add: bash batching, /compact cadence, CLI-over-MCP preference, cache hygiene (≤30 lines net per file) | Low. |
| **A6 — fullstack override** | Add operator-trigger note to `fullstack/CLAUDE.md` for per-task Opus override | Trivial. |
| **A8 — quality fixes** | Generalize `boss/HEARTBEAT.md:60-74` disk-pressure incident snippet; delete `analyst/CLAUDE.md:307-335` "Spawning a New Agent" section (analyst doesn't spawn); verify/deprecate `analyst/GUARDRAILS.md:23` BL-003 phase-3 reference | Low. |

## Code-side changes required for A3 deletes

Without these, the daemon will tell every agent on startup "Read AGENTS.md" — referring to a file you just deleted. **Do these in the same commit as the deletes.**

1. **`src/daemon/agent-process.ts:527,534`** — replace `Read AGENTS.md` / `Re-read AGENTS.md` with `Read CLAUDE.md` / `Re-read CLAUDE.md` in the startup + continuation prompt strings. (Also update line 522's handoff-UX text mentioning "AGENTS.md step 1".)
2. **`src/daemon/agent-process.ts:509-511`** — the `existsSync(onboardingPath)` branch appends "read ONBOARDING.md". Replace with a check that prefers `.claude/skills/onboarding/SKILL.md` and falls back to `ONBOARDING.md` only for older agent dirs without the skill. Pattern:
   ```ts
   if (!existsSync(onboardedPath)) {
     const onboardingSkillPath = join(this.env.agentDir, '.claude', 'skills', 'onboarding', 'SKILL.md');
     if (existsSync(onboardingSkillPath)) {
       onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read .claude/skills/onboarding/SKILL.md and complete the onboarding protocol.';
     } else if (existsSync(onboardingPath)) {
       onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
     }
   }
   ```
3. **`src/cli/add-agent.ts:342-388`** — `createMinimalAgent` writes `TOOLS.md`, `CLAUDE.md` (as `@AGENTS.md` import), and `AGENTS.md` via `createAgentsMd()`. Replace with a single self-contained `createClaudeMd()` that writes a ~30-line `CLAUDE.md` pointing at skills. Delete `createAgentsMd`. Drop `TOOLS.md` write entirely (the canonical reference lives at `docs_sb/guides/bus-cli-reference.md`).
4. **`src/utils/cron-teaching-scanner.ts:29`** — `AGENT_TOP_FILES = ['CLAUDE.md', 'AGENTS.md', 'ONBOARDING.md']` → `['CLAUDE.md']`. Add a comment noting AGENTS/ONBOARDING were removed PR-A2.

## Test fix strategy

Run `npm test` after the deletes to see the actual failure set. Expect ~70 failures across these files (the count + files were observed during the prior attempt):

- `tests/sprint1-templates.test.ts` (6 failures) — drop the `'AGENTS.md', 'ONBOARDING.md', 'TOOLS.md'` from the `requiredFiles` array; delete tests asserting on those files' content (`TOOLS.md has complete script inventory`, `ONBOARDING.md has 5 parts`, etc.); keep tests asserting CLAUDE/SOUL/HEARTBEAT/GUARDRAILS contents but verify they still match the trimmed content.
- `tests/integration/phase3-docs.test.ts` (54 failures) — most assertions are `templates/*/AGENTS.md > file exists` + content assertions. Either delete the entire `3.1 — templates/*/AGENTS.md External Persistent Crons section` describe block, OR rewrite those assertions to target `templates/*/CLAUDE.md` and verify the cron content moved there (likely to the cron-management skill).
- `tests/integration/phase3-docs-backtest.test.ts` (2 failures) — `ONBOARDING.md Step 9` assertions; rewrite to target the onboarding skill at `.claude/skills/onboarding/SKILL.md`.
- `tests/integration/cron-migration-banner.test.ts` (1 failure) — likely transitive on AGENTS.md scan; should pass once scanner constant is updated.
- `tests/unit/utils/cron-teaching-scanner.test.ts` (4 failures) — directly tests the scanner; update fixtures + expected counts after AGENT_TOP_FILES constant shrinks.
- `tests/integration/upgrade-cron-teaching-cli.test.ts` (1 failure) — pre-existing failure on `main` per PR #23 notes; ignore or fix separately. Re-verify in case it tipped post-A3.
- `tests/integration/phase5-user-journeys.test.ts` (2 failures) — content assertions; spot-check.

**Strategy: do code edits + deletes first, run tests, then update tests in a SEPARATE COMMIT** so the diff is reviewable per layer (code | deletes | trims | tests). Don't smash everything into one commit.

## Per-role trim targets (from the plan)

| Role | File | Current lines | Target | Cut what |
|---|---|---:|---:|---|
| boss | CLAUDE.md | 377 | **160** | "First Boot Check" (route to onboarding skill); Memory Protocol → `memory-discipline` skill; "Spawning a New Agent" → orchestrator-specific skill or inline shorter; Telegram boilerplate → `comms` skill ref. **KEEP**: role definition, daily ops summary, skill index. |
| analyst | CLAUDE.md | 419 | **140** | Same boot/session/memory blocks; **DELETE "Spawning a New Agent" 307-335** (analyst doesn't spawn — A8 quality fix); "Analyst Responsibilities" 383-420 → `system-diagnostics` skill. |
| engineer | CLAUDE.md | 308 | **120** | Boot/session/memory boilerplate; worktree discipline (50 lines) → reference `worktree-discipline/SKILL.md`. **KEEP**: code-task workflow, build/test cadence. |
| devops | CLAUDE.md | 308 | **120** | Same shape as engineer; emphasize ops surface. |
| fullstack | CLAUDE.md | 308 | **120** | Same shape as engineer + A6 Opus-override paragraph. |
| all | HEARTBEAT.md | 141-312 | **50-100** | boss 218→80, analyst 312→80, others 141-160→50. Cut the 2026-05-07 disk-pressure incident-specific block from `boss/HEARTBEAT.md:60-74` (A8 generalize to "check disk quarterly"). |
| all | SOUL.md | 63-104 | **30** | Identical 60+ lines across roles → reference shared `soul-philosophy` skill. Keep role-specific 5-10 lines. |
| all | GUARDRAILS.md | 47-68 | **25-35** | Keep core red-flag table (tested!). Cut role-irrelevant rows. Verify A8 `analyst/GUARDRAILS.md:23` BL-003 phase-3 reference is still current. |

**Important — tests assert specific content:**
- `tests/sprint1-templates.test.ts:59` — "CLAUDE.md has first boot check" — keep something matching the test's regex (read the test before trimming).
- Same file `:78` — "HEARTBEAT.md has 9 steps" — preserve the 9-step structure or update the test.
- Same file `:101` — "GUARDRAILS.md has red flag table" — preserve the table.
- `:71` — "SOUL.md has system-first mindset" — preserve that phrase or update the test.

**Recommendation:** read each test assertion BEFORE trimming the corresponding file, so you preserve the right shape or pre-update the test.

## Apply both layers — templates AND live fleet

`orgs/` is gitignored — only `templates/` ships in the PR diff. But the live fleet at `orgs/sb-personal/agents/<role>/*.md` is what's actually running. **Apply both**:

```bash
# Templates first (these ship in the PR)
# ... edit templates/agent/CLAUDE.md, templates/analyst/CLAUDE.md, etc ...

# Then mirror role-by-role into live fleet
# (per-role since each role's content differs)
cp templates/orchestrator/HEARTBEAT.md orgs/sb-personal/agents/boss/HEARTBEAT.md   # if identical post-trim
# ... else hand-edit each live file ...

# Verify the live trim took effect immediately (no daemon restart needed for prompt-file content)
wc -l orgs/sb-personal/agents/*/CLAUDE.md orgs/sb-personal/agents/*/HEARTBEAT.md
```

The migration script at `scripts/migrations/2026-05-cost-context-optimization.sh` was config-focused (A1/A2). Consider extending it OR write a sibling script `scripts/migrations/2026-05-restructure-fleet-files.sh` that copies post-trim templates → live fleet for any role whose content matches the template after trim. If a role's content diverges from the template (likely for boss + analyst), hand-edit those.

## Working loop (per phase)

Per the global instructions:

1. **Per phase** (e.g. "A3 deletes + code edits", "A3 trims for boss", "A3 trims for analyst", ...): implement → `code-evaluator` subagent → fix in separate commit → LGTM. LGTM gates the next phase.
2. **Per PR**: push → `pr-deep-evaluator` subagent → fix → `gh pr merge --merge --delete-branch --repo saurav-yirifi/sb-cortextos-fork`.
3. **Commit hygiene**: NEVER `--amend` on pushed commits; NEVER `--no-verify`; create new commits for fixes. Always pass `--repo saurav-yirifi/sb-cortextos-fork` on `gh` calls (fork-default trap).

## Anti-patterns / failure modes to avoid

- **Don't trim away content the tests assert on without updating the test.** Pre-PR, run `npm test` against your new state; per-phase if you're in the trim weeds.
- **Don't `git checkout main` in the canonical tree** — the user has an analyst worktree there. Use `git worktree`.
- **Don't write `/Volumes/MacStorage/...` paths in any new file.** Use `$CTX_FRAMEWORK_ROOT` / `$CTX_JARVIS_ROOT` env. The code-evaluator already flagged this in PR-A round 1.
- **Don't delete `docs/architecture/` or `docs/phase-reports/`** — they're force-added tracked files under the otherwise-gitignored `docs/`. Prior session lost track of this once.
- **`orgs/` and `docs/` are both gitignored at the top-level `.gitignore`** — your trims to `orgs/` won't appear in the diff. That's correct; the migration script handles the fleet activation. PR diff is `templates/` + `src/` + `tests/`.
- **Don't compose `cd <canonical> && git ...` in one Bash call** — that auto-prompts for permission. Just run `git ...` from the worktree directly.

## Acceptance gates (before opening PR)

- [ ] All deletes + code edits + trims + test updates committed.
- [ ] `npm run build` clean.
- [ ] `npm test` — at most 1 pre-existing failure (the same `upgrade-cron-teaching-cli.test.ts` PR-A noted; flag if any new failures).
- [ ] Per-role CLAUDE.md line count within plan target range (boss 160, analyst 140, others 120; ±10).
- [ ] `tests/sprint1-templates.test.ts` updated for the new `requiredFiles` array.
- [ ] Boss `HEARTBEAT.md:60-74` disk-pressure snippet generalized or removed.
- [ ] Analyst `CLAUDE.md` "Spawning a New Agent" section removed.
- [ ] Analyst `GUARDRAILS.md:23` BL-003 phase-3 reference resolved (current → keep, stale → deprecate inline).
- [ ] Fullstack `CLAUDE.md` has the Opus-override paragraph.
- [ ] Each per-role `CLAUDE.md` has the A5 prose block (bash batch / /compact / CLI-over-MCP / cache hygiene).

## PR description (template)

PR title: `feat: cost & context optimization (PR-A2 — A3 trims + deletes + tests)`

Body sections to include:
- **Summary**: what landed (A3+A5+A6+A8); reference PR #23 as part 1.
- **Per-role file diffs**: before/after line counts per role, per file.
- **Code edits**: enumerate the 4 src/ files touched + why.
- **Test updates**: list which test files changed and what the asserts now target.
- **Activation**: `git pull && npm run build && pm2 restart cortextos`. The fleet's `orgs/` files were updated in-place by your PR work + (optionally) the new migration script.
- **Rollback**: `docs_sb/agent-file-backups/2026-05-11-pre-restructure/` has every original file; revert path is `git revert` + copy from backup for the gitignored live-fleet files.

## Out of scope for PR-A2 (defer further)

- **HOW-TO-USE.md topical split** in jarvis — already monolithic-moved in PR #156; per-topic split is a separate content-rewrite task.
- **Auto-gen `/Volumes/...` paths in jarvis CLAUDE.md** — fix lives in the generator, not the file.
- **Phase 2 daemon-side cost controls** (USD budget caps, live cost statusline, cron-injection slim-down) — separate PRs after the file-restructure dust settles.
- **Phase 3 experimentation** — Advisor Strategy, Haiku for procedural roles — depends on observing 2-week regression window from PR-A + PR-A2.
