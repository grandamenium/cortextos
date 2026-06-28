---
name: branch-prune
description: Branch and prune methodology for AI coding agents. User-invoked only (/branch). Generates N independent solution variations in parallel subagents (own git worktree each), reviews each variation with its own review subagent, prunes via a single fair LLM judge or manual user judgment, and delivers per-variation git branches plus a report doc with a winner-based merge suggestion the user can approve with a single OK. Works for planning, features, UI, and non-coding tasks like copywriting.
---

# Branch and Prune

Stop committing to the first idea your agent has. Generate several genuinely
different solutions in parallel, review each one, prune to a winner, and merge
it with one OK.

This skill is interactive by design: it asks the user at every consequential
decision point (branch count, diversity axes, subagent config, judging mode,
synthesis). Do not silently substitute defaults for any of those asks.

## When to run

ONLY when the user explicitly invokes it (`/branch` or "run branch and prune").
Never trigger automatically. The user brings a task: an architecture to plan, a
feature to build, a UI to design, or a non-coding artifact (copy, docs, naming).

## Phase 1 — Frame the task

1. Restate the task in one sentence and confirm scope with the user if any
   ambiguity exists.
2. Detect the task level: planning / feature implementation / UI / non-code.
   The level changes what a "variation" is (architecture doc, working diff,
   mockup + component code, draft copy) but not the process.
3. If the task mutates files, confirm you are in a git repository with a clean
   enough working tree to cut worktrees from HEAD. If not in a git repo, offer
   `git init` or fall back to report-only output (Phase 7, option c).

## Phase 2 — Branch count (ask user)

Ask the user how many variations to generate. There is NO cap — honor whatever
number they give.

If N > 6, include this informed-cost note in the question (warn, never block):

> Heads up: N variation subagents + N review subagents, each in its own git
> worktree — token and disk cost scale linearly with N. I can also run them
> sequentially instead of in parallel to smooth the load. Proceed in parallel,
> go sequential, or pick a smaller N?

The user's answer is final. Never cap, never re-ask.

## Phase 3 — Diversity axes (suggest 5-10, user picks)

Derive 5-10 diversity axes FROM THE TASK and present them with the
AskUserQuestion tool (multiSelect). Axes are dimensions along which variations
should differ — the goal is distinct outputs, not N restylings of one idea.

Example axes (adapt to the task, do not copy verbatim):
- Architecture paradigm (monolith vs modular vs event-driven)
- Risk posture (conservative minimal-diff vs aggressive rewrite)
- Dependency footprint (stdlib-only vs best-in-class libraries)
- Optimization target (readability vs performance vs extensibility)
- Interface-first vs data-model-first design order
- Error-handling philosophy (fail-fast vs degrade-gracefully)
- For UI: density, navigation pattern, visual hierarchy
- For copy: tone, angle, audience sophistication

The user picks which axes matter. Assign each variation a distinct position on
the chosen axes so no two variation prompts collapse into the same instruction.

## Phase 4 — Subagent config (ask user)

Ask the user how to configure the variation subagents:
- Forked from the current session context, or fresh context?
- Which model per subagent (same for all, or per-variation)?
- Parallel or sequential execution (pre-answered if Phase 2 raised it)?

## Phase 5 — Generate variations (one subagent per variation)

For each variation i of N:

1. Create an isolated git worktree:
   `git worktree add ../<repo>-branch-i -b branch-prune/variation-i`
   (For non-file tasks, skip worktrees; each subagent returns its artifact as
   text.)
2. As the orchestrator, WRITE A DISTINCT PROMPT for each subagent encoding its
   assigned axis positions. The prompts must instruct variations to disagree or
   vary in the specific chosen ways. Subagents are independent: no variation
   sees another's prompt or output.
3. Launch the subagents (Agent tool / Task tool), parallel or sequential per
   the user's Phase 4 answer.

Error handling (exact contract):
- If a variation subagent errors, REDEPLOY it (relaunch the same variation
  prompt). Do not drop the branch, do not halt the run.
- After 3 CONSECUTIVE failed redeploys of the same variation, stop retrying it
  and ask the user with AskUserQuestion. The question MUST include the actual
  failure reason from the last attempt (error text or summary) so the user
  decides informed. Options: keep retrying / drop this branch / halt the run.
  (Provenance note: this 3-fail escape is a safety default added by the skill
  authors as an anti-infinite-loop guard — the design spec said only
  "redeploy, no cap" — and was subsequently confirmed by the spec owner as
  intended behavior. It is part of the contract.)
- Never silently drop a variation.

## Phase 6 — Review and prune

1. Per-variation review: launch one review subagent PER variation (same
   isolation rules). Each review covers correctness, completeness against the
   task, and notable tradeoffs, and returns a structured summary.
2. Convergence check: if two variations are near-identical, KEEP BOTH and flag
   the convergence in the report (it is signal about the solution space, not
   waste). Do not dedupe.
3. Judging — ask the user (AskUserQuestion):
   - LLM judge: a SINGLE judge subagent reviews ALL variations in one pass so
     comparisons are fair (same judge, same criteria, same context). Also ask
     WHICH SURFACE to judge: the diffs, the review summaries, the rendered
     artifacts, or test results.
   - Manual: present the report (Phase 7) and the user ranks/picks.
4. If LLM judge: PROPOSE a default rubric and let the user edit it before the
   judge runs. Default: correctness 40% / fit-to-task 30% / simplicity 20% /
   extensibility 10%. The user's edited rubric is what the judge receives.

## Phase 7 — Output and merge (single OK)

Produce, in this order:

a. Git branches: one branch per variation (`branch-prune/variation-i`),
   pushed nowhere — local only unless the user says otherwise.
b. Report doc (`branch-prune-report.md` in the repo root, or printed in chat
   for non-file tasks) containing: the task, chosen axes, every variation with
   its axis positions and review summary, judge scores per rubric line (if LLM
   judged), convergence flags, dropped/failed branches with reasons, and a
   WINNER-BASED MERGE SUGGESTION: which branch to merge and why, plus anything
   worth grafting from runners-up.
c. Synthesis — ask the user: merge the winner as-is, merge winner + graft
   named pieces from runners-up, or take the report and decide later.
d. On the user's single OK: perform the merge of the suggested branch into the
   working branch. Then clean up worktrees
   (`git worktree remove ../<repo>-branch-i`), keeping the variation branches
   for reference unless the user asks to delete them.

Do not merge anything before the explicit OK.

## Pro tip (not built into this skill)

Variation diversity can be pushed further by generating different variations
with different LLM vendors (e.g. Gemini for one, Codex for another, Claude for
a third). This skill deliberately does not orchestrate other vendors' CLIs —
run those variations manually and feed their outputs into Phase 6 as extra
entries if you want this.
