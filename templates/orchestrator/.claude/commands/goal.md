---
description: Long-horizon autonomous goal pursuit — Codex-style /goal. Plan→act→test→commit→iterate until objective met or budget exhausted.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, Task
argument-hint: <goal text> [--budget=N]
---

# /goal — autonomous objective execution

Modeled on OpenAI Codex CLI's `/goal`. You operate continuously: plan, act, test, review, iterate — without waiting for user prompts between each task. You stop only when:

1. The success criteria in `GOAL.md` are demonstrably met (tests green, evidence in commits), OR
2. The iteration budget is exhausted (`./.claude/scripts/goal-budget.sh exhausted` exits 0), OR
3. You hit a blocker that genuinely requires human input (then write it into `GOAL.md` under "Blocked on" and stop).

## Args

`$ARGUMENTS` may contain:
- A goal description (free text)
- Optional `--budget=N` (default 50 iterations)
- Optional `--resume` (don't re-init state; continue existing goal)

## Phase 0 — Bootstrap

Run **once** at the start of a `/goal` invocation:

1. Parse args. Extract `--budget=N` (default 50) and `--resume` flag. Remainder is the goal text.
2. If `--resume` AND `.claude/.goal-state.json` exists AND `GOAL.md` exists → skip to Phase 2.
3. Otherwise initialise:
   ```bash
   .claude/scripts/goal-budget.sh init <budget> "<goal text>"
   ```
4. Write `GOAL.md` with this structure:
   ```markdown
   # Goal: <one-line objective>

   ## Success criteria
   - [ ] Concrete, testable criterion 1
   - [ ] Concrete, testable criterion 2
   - ...

   ## Validation command
   <project-specific test/lint/typecheck chain — see CLAUDE.md "Validation Loops">

   ## Blocked on
   (none)

   ## Started
   <ISO timestamp>
   ```
   Success criteria must be **verifiable** — each one is a check-box you can prove green via a command or file inspection. If the goal text is vague, infer specific criteria; if you can't, surface the ambiguity in `GOAL.md` and stop.
5. Write `PLAN.md` with the initial task breakdown:
   ```markdown
   # Plan

   ## Pending
   - [ ] task 1 (atomic, ≤30 min, owns a single concern)
   - [ ] task 2

   ## In progress
   (none)

   ## Done
   (none)

   ## Notes
   <anything you learned during planning>
   ```
6. Mirror tasks into TodoWrite for in-session tracking.

## Phase 1 — Plan refinement (optional)

Before iterating, scan the codebase if needed (Read/Grep/Glob) to validate that the plan tasks are realistic. Update `PLAN.md` if you find better decomposition. Don't let this phase consume more than a couple of minutes — over-planning is procrastination.

## Phase 2 — The loop

Repeat until exit condition:

### 2a. Check budget

```bash
.claude/scripts/goal-budget.sh exhausted
```

If exit 0 (exhausted) → jump to **Phase 3 — Wrap**.

### 2b. Pick next task

Read `PLAN.md`. Take the **top "Pending"** item. Move it to "In progress". Update `PLAN.md` and TodoWrite together.

If `PLAN.md` has no pending tasks but success criteria aren't met → either decompose deeper (write new tasks) or surface the gap in `GOAL.md` "Blocked on".

### 2c. Execute the task

Implement it. **Read before edit, edit don't rewrite.** Follow project conventions in CLAUDE.md.

### 2d. Validate

Run the validation command from `GOAL.md`. **Iterate up to 3 times** on failures:

- Failure 1 → re-read the error, fix the implementation, re-run.
- Failure 2 → fix again, run.
- Failure 3 → if still failing: append the failure trace to `GOAL.md` "Blocked on", revert the in-progress edits (`git restore .` for unstaged, leave staged) if they leave the tree broken, move task back to Pending with a "blocked:" prefix, and continue to next task.

**Anti-cheat enforcement** (per CLAUDE.md): never modify tests to pass, never `# type: ignore`, never delete failing tests. If validation requires that, the task is genuinely blocked — surface it.

### 2e. Commit

On green validation:
```bash
git add <files-you-changed>
git commit -m "<conventional commit>: <task summary> (goal iter <iter>)"
```
Don't `git add .` blindly — stage only the files this task owns.

### 2f. Update state

- Move the task to "Done" in `PLAN.md`. Mark TodoWrite completed.
- Re-check `GOAL.md` success criteria. Tick any boxes the just-completed task satisfies.
- Increment iteration counter:
  ```bash
  .claude/scripts/goal-budget.sh tick
  ```
- If all success-criteria boxes are now ticked → mark complete and jump to Phase 3:
  ```bash
  .claude/scripts/goal-budget.sh complete
  ```

### 2g. Loop

Return to 2a. Do **not** wait for user input.

## Phase 3 — Wrap

When the loop exits (success, exhausted, or blocked):

1. Run `git status` and `git log --oneline -10` so the user sees what landed.
2. If goal completed AND any non-trivial code shipped → run `/local-ultrareview` (Gate 1) before declaring "done". This is the same quality gate enforced by the project's PreToolUse hook for PR creation.
3. If skill-driven (≥3 Skill calls this session) → the Stop hook will surface a `skill-optimizer` reminder; honor it.
4. Write a final `GOAL_REPORT.md`:
   ```markdown
   # Goal report

   - **Goal:** ...
   - **Outcome:** completed | budget-exhausted | blocked
   - **Iterations used:** X / Y
   - **Commits:** <list of SHAs + messages>
   - **Success criteria:** which ticked, which not
   - **Blockers (if any):** ...
   - **Suggested next /goal:** (if more work remains)
   ```
5. Print a 3-line summary to the user with: outcome, criteria status, link to `GOAL_REPORT.md`.

## Files this command owns

| File | Purpose | Lifecycle |
|---|---|---|
| `GOAL.md` | objective + success criteria + validation cmd | written Phase 0, updated Phase 2f, archived Phase 3 |
| `PLAN.md` | task list (Pending/In progress/Done) | written Phase 0, updated every iteration |
| `.claude/.goal-state.json` | iteration counter (out-of-band, can't be fudged by the model) | managed by `goal-budget.sh` |
| `GOAL_REPORT.md` | final outcome | written Phase 3 |

## Operating principles

- **Atomic tasks.** Each task is committable in isolation. If a task touches >5 files or >200 lines, decompose it.
- **Validation is non-negotiable.** No "skipping tests" to keep the loop moving. The point of the loop is each iteration is provably-good before the next one starts.
- **Cheap tasks first** when ordering Pending — fast-feedback work surfaces blockers early.
- **Commit per task, not per session.** The git log IS the audit trail of what /goal did.
- **No ambient cleanup.** Do not refactor unrelated code "while you're here". One task = one commit = one concern.
- **Read CLAUDE.md once at the start** so the validation command + project conventions are in your working memory.
- **Honor the quality gates.** PreToolUse already blocks `gh pr create` and pushes to main without a fresh `/local-ultrareview`. Do not try to bypass; do the review when prompted.

## When NOT to use /goal

- One-off questions or single-edit fixes (just do them).
- Tasks where the user wants to make decisions per step.
- Open-ended exploration where success criteria can't be made concrete.

## Example invocations

```
/goal ship the 18 features in BACKLOG.md before standup --budget=40
/goal make `npm run typecheck` pass cleanly across all dk-bolig packages
/goal --resume      # continue an existing goal
```
