# WS12 — Better Coding Agent by Default

_Spec written 2026-07-04. Planning pass only — no code, no PRs, no prod runs._

## 1. GOAL

Make cortext's default coding behavior disciplined and isolated so a dispatched code task cannot corrupt the live working tree or drift from its spec — directly serving Josh's governing goal of **certainty** (a code task's outcome is verified and scope-bounded before it returns) and a **reliable remote manager** (Josh can dispatch a build from his phone and trust that it ran in isolation, self-verified, and stayed in scope). Bake fixes A (explore→plan→adversarial-review→implement→verify loop), B (mandatory git-worktree isolation), D (loop-until-verified self-fix), and F (delegation matrix in SOUL) into the agent-codex template + codexer SOUL/AGENTS via a new `codex-handoff` skill. E (SCOPE_GUARD) is already shipped — invoke it, do not rebuild.

## 2. GROUNDED CURRENT STATE (fork/main today)

Verified by reading the real files on `main` (not the upstream-based WS12 worktree, which is a conflict bomb — see Risks).

**What exists and is good:**
- **Gap E is SHIPPED.** `SCOPE_GUARD` merged at `3f280f0` (`feat(bus): SCOPE_GUARD — deterministic real-time scope-drift checker (WS12 gap E) (#51)`). Implementation is real and read-only: `src/bus/scope-guard.ts` (CLI layer — `runScopeGuard`, `resolveDeclaredGlobs`, `collectTouchedFiles`, `parseScopeFile`), `src/utils/scope-guard.ts` (pure `checkScope`), wired into `src/cli/bus.ts`. `collectTouchedFiles` already supports a `base` ref (three-dot merge-base diff) plus working-tree + untracked files (`scope-guard.ts:88-106`), and `parseScopeFile` already reads a spec's `Targets:`/`Files-Touched:` field (`scope-guard.ts:47-68`). **This is the drift primitive WS12 needs; the spec calls it, does not touch it.**
- **Hook-enforced role boundaries exist.** `orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh` blocks any `send-message codexer` build dispatch unless the declared framework's planning artifacts exist, are fresh (`-mtime -14`), and are work-bound to the slug in the REAL target repo (`gate-codexer-planning.sh:75-88`); also blocks down-classifying M2C1-scale work (`:60-70`). `block-direct-coding.sh` and `architect-spec-review.sh` also exist in that hooks dir.
- **codexer already self-verifies + returns-once.** `orgs/clearworksai/agents/codexer/AGENTS.md:20-29` mandates "build every shard, run the repo gate, include gate output, return the whole diff once." `codexer/SOUL.md:47` states the deterministic workflow (Larry plans → codexer adversarially reviews the plan → implements → Larry adversarial build review → PR).

**What is MISSING (the WS12 gaps that are still real):**
- **Gap B (worktree isolation) — CONFIRMED MISSING and highest value.** `grep -ri "git worktree"` across `templates/` and the live larry/codexer agent dirs returns **zero** hits in any operational doc or template (only old handoff logs mention it narratively). Codex edits happen in the LIVE working tree today — the exact dirty-tree/branch-hijack class that bit the WS1 run.
- **The `codex-handoff` skill does NOT exist on the fork.** `find` for a `codex-handoff` skill directory (excluding worktrees/node_modules) returns nothing. It is referenced as if real in `orgs/clearworksai/agents/codexer/CLAUDE.md` ("Repo agents … own Codex handoffs via the `codex-handoff` skill") but the skill file was only ever created on the upstream-based WS12 worktree (`c896752`), which is NOT on main. **This is a dangling reference — a claim of a skill that does not exist.**
- **`codex:rescue` is referenced but never defined.** `codexer/AGENTS.md:7,24` says "implement via codex:rescue" but there is no skill or command file defining it on the fork.
- **Gap A (explore→plan→adversarial-review→implement→verify as a MANDATORY default) — partial.** Adversarial review of the *plan* and *build* exists in codexer/SOUL, but there is no explicit, ordered, mandatory five-step loop for any change ≥10 lines, and `explore` (read the real files first) is not a named gate.
- **Gap D (loop-until-verified self-fix, max 2) — MISSING.** Today codexer runs the gate once; on failure the pattern is to return to Larry (`codexer/AGENTS.md:27`), not to self-fix ≤2× before escalating.
- **Gap F (delegation matrix in SOUL) — MISSING from where it needs to be.** The matrix exists only as a standalone reference skill `community/skills/delegation-matrix/SKILL.md` (3-mode: reviewer-only / implementer+reviewer / no-codex). It is NOT condensed into `templates/agent-codex/SOUL.md`, so a fresh codex agent does not carry it by default.

**What is BROKEN / inconsistent (surface, don't fix broadly here):**
- **Role contradiction:** `codexer/CLAUDE.md` Task-Type Routing says "CODE IMPLEMENTATION — NOT in your scope … You do not run Codex yourself," while `codexer/AGENTS.md` and `codexer/SOUL.md:43` say codexer DOES implement via Codex. WS12 must not deepen this. See Open Questions.

## 3. DESIGN (concrete, minimal, in-scope)

Doctrine-and-template change, not a runtime-engine change. The enforcement primitives already exist (SCOPE_GUARD binary, gate hook, self-verify rule). WS12 adds one skill + additive doctrine sections that make A/B/D/F the default, and adds one optional-but-recommended hook for B.

### 3.1 New skill: `codex-handoff` (the coding-workflow contract)

Create the skill that is currently dangling. Author it as the **single source of truth** for the mandatory coding loop, then reference it from SOUL/AGENTS (do not duplicate the body).

- **File:** `templates/agent-codex/.claude/skills/codex-handoff/SKILL.md` (place under `.claude/skills/` to match how `add-agent-codex.test.ts` enumerates the codex template's skills at `:127-133`).
- **Body — the mandatory loop for any change ≥10 lines:**
  1. **EXPLORE** — read the real target files (paths from the spec's `Files-Touched:`) before editing. No delegated summaries. (Ties SCOPE_LOCK's "read source yourself" up-front.)
  2. **PLAN** — restate the spec's contract + the exact files to touch; if the spec has no `Files-Touched:`/`Targets:` field, BLOCK back to Larry (SCOPE_GUARD needs it).
  3. **ADVERSARIAL REVIEW (default, not opt-in)** — critique the plan: right question? JSON contract? machine-readable done-criteria? (mirrors `codexer/SOUL.md:47`).
  4. **IMPLEMENT — inside a git worktree (gap B, see 3.2).**
  5. **VERIFY with loop-until-verified self-fix (gap D):** run the repo gate (`npm test` / `bin/verify.sh` / `npm run check` — the per-repo command is authoritative, see larry/CLAUDE.md repo table); if it fails, self-fix and re-run, **max 2 retries**; still failing → BLOCK to Larry with the failing gate output **verbatim** (no paraphrase — certainty).
  6. **SCOPE CHECK (gap E, invoke the shipped tool):** run `cortextos bus scope-guard --scope-file <spec> --base <branch-base>` (uses the existing `runScopeGuard` → `collectTouchedFiles` base-diff at `scope-guard.ts:88-106`). Stray files → revert or escalate before returning the diff. **Do not reimplement scope-guard.**
- **Byte-identical mirror to keep skill-parity green:** the `templates/agent` (Claude) template has a parallel skills tree and a parity test. Add the same file at `templates/agent/.claude/skills/codex-handoff/SKILL.md` so the base agent template also carries the contract. (The upstream WS12 commit did exactly this to keep the parity test green.)

### 3.2 Gap B — mandatory git-worktree isolation

Two layers, doctrine + optional guard:
- **Doctrine (in the skill, step 4):** every codex implementation run creates and works in a dedicated worktree, never the live checkout:
  ```
  git worktree add ../.wt/<slug> -b codex/<slug> <base>
  # implement + verify inside ../.wt/<slug>
  git worktree remove ../.wt/<slug>   # after diff is captured / PR opened
  ```
  The diff Larry reviews and the PR both come off `codex/<slug>`, never off whatever branch happened to be checked out.
- **Optional enforcement hook (recommended, small):** `orgs/clearworksai/agents/codexer/.claude/hooks/require-worktree.sh` — a PreToolUse(Edit|Write) hook that blocks edits to `.ts/.tsx/.js/.py/.go` when the cwd is the primary working tree (i.e. `git rev-parse --git-common-dir` == `.git`, meaning not a linked worktree). Mirrors the existing hook style in larry's `.claude/hooks/`. **Gate this on Open Question Q3** — codexer may run via a PTY runtime where a PreToolUse hook does not fire; if so, keep B as doctrine-only in the skill and rely on the SCOPE_GUARD base-diff to catch cross-branch bleed. Confirm before building the hook.

### 3.3 Gap F — delegation matrix into SOUL

Condense `community/skills/delegation-matrix/SKILL.md` (the 3-mode table) into a short (~15-line) `## Delegation Matrix` section appended to `templates/agent-codex/SOUL.md`. Keep the community skill as the full reference; SOUL carries the default-mode summary (Mode 1 reviewer-only out of box; execution-heavy → Codex if configured; judgment-heavy → Agent always) so a fresh codex agent carries it without reading a separate file. **Do NOT design model routing here** — that is WS8 (separate, from the creator video). This is workflow ownership only.

### 3.4 Doctrine wiring (additive, no rewrites)

- `templates/agent-codex/SOUL.md`: append `## Coding Discipline` (points A/D, references the codex-handoff skill) + `## Delegation Matrix` (F). Additive only — do not touch the existing Autonomy/Day-Night sections.
- `templates/agent-codex/AGENTS.md`: append `## Coding Workflow (mandatory)` pointing at the skill for the ordered loop + worktree rule. Leave the existing "Build the WHOLE feature, self-verify, return once" section (`:20-29`) intact — the new loop is the per-change discipline inside it.
- `orgs/clearworksai/agents/codexer/`: apply the same two additive sections to the LIVE codexer's SOUL.md + AGENTS.md so the running agent gets it (templates only affect newly-created agents). This is the one place we touch a live agent's doctrine files — additive text, no behavior code.

## 4. STAGING / PROD-OPS

- **No prod data touched.** This WS is doctrine + one skill + one optional hook. Nothing runs against Clearpath/briefs/prod DBs.
- **Live-agent doctrine edit is Josh-gated but low-risk.** Editing the running codexer's SOUL.md/AGENTS.md (3.4) changes how the live codexer behaves on next session. It is additive text, but it IS a live-fleet change → **surface the diff to Josh before applying to the live codexer dir.** The `templates/` changes are safe (only affect newly-spawned agents).
- **The optional worktree hook (3.2) must be validated against the actual codex runtime before enabling** — if codexer edits via a PTY app-server (see `src/pty/codex-app-server-pty.ts`) where PreToolUse hooks do not intercept, the hook is inert and worktree isolation must live in the skill doctrine + SCOPE_GUARD. Confirm the runtime path (Q3) in a throwaway test before wiring the hook. Staging-first is the fleet-consolidation default per Josh's rulings.
- **No merge to main without Josh approval** (larry/CLAUDE.md hard rule). One cortextos PR at the end.

## 5. FILES TO TOUCH (tight — avoid the broad-refactor conflict bomb)

New:
- `templates/agent-codex/.claude/skills/codex-handoff/SKILL.md` (the contract — source of truth)
- `templates/agent/.claude/skills/codex-handoff/SKILL.md` (byte-identical mirror for skill-parity)
- `orgs/clearworksai/agents/codexer/.claude/hooks/require-worktree.sh` (OPTIONAL, gated on Q3)
- `tests/unit/cli/codex-defaults.test.ts` (pins A/B/D/F presence — see Test Plan)

Edit (additive sections only):
- `templates/agent-codex/SOUL.md` (Coding Discipline + Delegation Matrix)
- `templates/agent-codex/AGENTS.md` (Coding Workflow mandatory)
- `orgs/clearworksai/agents/codexer/SOUL.md` (live agent — Josh-gated)
- `orgs/clearworksai/agents/codexer/AGENTS.md` (live agent — Josh-gated)
- `tests/unit/cli/add-agent-codex.test.ts` (bump pinned skill count 23→24 at `:131`, add `codex-handoff` to the `toContain` spot-checks at `:133-134`)

Explicitly OUT of scope (do not touch): `src/bus/scope-guard.ts`, `src/utils/scope-guard.ts`, `src/cli/bus.ts` (gap E is done), `gate-codexer-planning.sh` (works), `community/skills/delegation-matrix/SKILL.md` (stays as full reference), the codex PTY runtime.

## 6. TEST PLAN

- **`tests/unit/cli/codex-defaults.test.ts` (new)** — pins the four doctrine fixes so they cannot silently regress (the pattern the upstream WS12 commit used):
  - A: agent-codex SOUL/AGENTS + the skill contain the ordered `explore → plan → adversarial-review → implement → verify` loop and the "≥10 lines" trigger.
  - B: the skill contains `git worktree add` and forbids editing the primary tree.
  - D: the skill contains the "max 2 retries then escalate with verbatim failing output" self-fix rule.
  - F: agent-codex SOUL contains a `Delegation Matrix` section naming the three modes.
- **`tests/unit/cli/add-agent-codex.test.ts` (edit)** — the existing skill-count assertion (`skills.length === 23` at `:131`) must be bumped to 24 and `codex-handoff` added to the `toContain` checks; run it to prove a newly-created codex agent ships the skill.
- **Skill-parity test (existing)** — must stay green after adding the byte-identical `templates/agent` mirror; run the full `tests/unit/cli` suite.
- **`require-worktree.sh` (if built)** — a small bats/shell test: feed it a PreToolUse payload for a `.ts` Edit in the primary tree → expect `block`; same payload in a linked worktree → expect pass. Only if Q3 says the hook fires.
- **Proof it works end-to-end:** `npm run build` clean + `npm test` green. The doctrine's real-world proof is a subsequent dispatched build running in `../.wt/<slug>` with a clean primary tree — validate that manually on a throwaway slug before claiming WS12 live (do not claim live off the diff alone — memory `feedback_agents_claim_live_without_verifying_deploy`).

## 7. RISKS + OPEN QUESTIONS

**Risks:**
- **The upstream WS12 worktree is a conflict bomb.** `wf/ws-ws12-codex-defaults` / commit `c896752` was built on UPSTREAM and carries unrelated commits (#699, #703, #704, security leak-guard, quota watchdogs). **Do NOT cherry-pick or rebase it onto the fork.** Re-author the `codex-handoff` skill and doctrine sections fresh against fork/main. It is a useful reference for the target shape only.
- **Dangling-reference risk if we ship doctrine but not the skill.** `codexer/CLAUDE.md` already points at a `codex-handoff` skill that doesn't exist; shipping more references without the file deepens a false claim. The skill file must land in the same PR as any reference to it.
- **Optional hook may be inert.** If codex edits via the PTY app-server, a PreToolUse hook won't fire → worktree isolation would silently be doctrine-only. Mitigation: verify Q3 before building the hook; SCOPE_GUARD base-diff is the backstop that catches cross-branch bleed regardless.
- **Live-agent doctrine drift.** Editing the running codexer's SOUL/AGENTS changes live behavior on next session — additive but Josh-gated (Section 4).

**Open questions for Josh:**
- **Q1 (role contradiction):** codexer/CLAUDE.md says "you do not run Codex yourself — route via frank2 to larry/auditos2," but codexer/AGENTS.md+SOUL say codexer DOES implement via Codex. Which is authoritative? WS12's skill should live wherever the codex *implementer* actually runs. Should WS12 also reconcile this contradiction, or is that out of scope?
- **Q2 (default delegation mode):** the delegation matrix has 3 modes. For Josh's fleet, is codexer Mode 2 (implementer+reviewer) the default, with larry as the reviewing Agent? Confirm so the SOUL summary states the right default.
- **Q3 (hook fires?):** does codexer edit files through a runtime where a PreToolUse(Edit|Write) hook intercepts (like larry's hooks), or through the Codex PTY app-server where it would not? Determines whether gap B gets a real enforcement hook or stays skill-doctrine + SCOPE_GUARD backstop.
- **Q4 (worktree location):** OK to use `../.wt/<slug>` as the worktree root (sibling to the repo, gitignored), or prefer a different convention?

## 8. EFFORT

**Effort: S–M.** Four additive doctrine sections + one new skill (mirrored) + two test edits is a **small direct job** (S) if the optional hook is deferred. It becomes **M** only if Q3 confirms the PreToolUse hook fires and we build + test `require-worktree.sh`. Does NOT need the full discovery→spec→sharded build pipeline — it is a single cohesive change in one repo with a tight file list. Route as `one-big-feature` (single feature, one repo), which also satisfies `gate-codexer-planning.sh`. The live-codexer doctrine edit and the optional hook are the only Josh-gated / staging-first steps.
