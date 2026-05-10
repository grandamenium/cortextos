# dual-review

Two code reviewers, in parallel, with disciplined reconciliation. Spawns the project-aware Claude `code-evaluator` subagent AND runs `codex review` (OpenAI Codex CLI) on the same diff. Reconciles findings (both / Claude-only / Codex-only) and surfaces a triaged punch list. The invoking agent then classifies each finding FIX / DISMISS-with-reason / ESCALATE.

The two evaluators are complements, not substitutes. Claude's `code-evaluator` reads project CLAUDE.md and `.claude/rules/`; Codex doesn't. Codex catches generic-best-practice patterns Claude over-tunes-out as "project convention." Combining cuts blind spots; reconciliation prevents oscillation between the two.

**Trigger phrases:**
- "run dual review"
- "/dual-review"
- "/dual-review <PR#>"

---

## When to use

- Before opening a PR — get the dual perspective before reviewers see it.
- On a tricky commit you're not sure about — sanity-check from two angles.
- When `code-evaluator` returned LGTM but the change touches sensitive code (auth, data, money) — Codex may catch what the project-tuned reviewer normalized.
- Before requesting merge approval on a high-risk change.

**When NOT to use:**
- On every commit. The eval-cost compounds; reserve for milestones.
- On trivial diffs (typos, formatting). Use plain `code-evaluator` if anything.
- As a substitute for `pr-deep-evaluator` on multi-phase PRs. They answer different questions: dual-review reads the diff; pr-deep-evaluator reads the PR's full structure (description, phases, wiring).

---

## Prerequisites

```bash
# Codex CLI must be installed
if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not installed; falling back to claude-only review"
  FALLBACK=1
fi

# AND authenticated — use exit code, not output text
# (different auth modes return different output strings; exit code is stable)
if [ -z "$FALLBACK" ] && ! codex login status >/dev/null 2>&1; then
  echo "codex not authenticated; falling back to claude-only review"
  FALLBACK=1
fi

# Add reviews/ to .gitignore if not already there — keeps session artifacts out of fix-commits.
# `[ -f .gitignore ]` short-circuits when .gitignore doesn't exist (otherwise grep's
# non-zero exit would abort under `set -e`).
if [ -f .gitignore ] && grep -qE '^reviews/?$' .gitignore; then
  :  # already ignored
else
  echo "reviews/" >> .gitignore
fi
```

If `FALLBACK=1`, the skill runs only Stage 1a (Claude evaluator) and skips Stage 1b (Codex). The reconciliation stage degrades to "single-evaluator triage."

To install codex: `npm install -g @openai/codex` then `codex login`. The plugin (`openai/codex-plugin-cc`) is NOT required — this skill invokes the CLI directly via bash so it works regardless of plugin install state.

---

## Setup

Determine the session dir, default branch, and get the diff:

```bash
PR_NUM="${1:-branch}"
TS=$(date -u +%Y-%m-%dT%H%M%SZ)               # full UTC timestamp — multiple runs/day don't overwrite
SESSION_DIR="reviews/dual-${PR_NUM}-${TS}"
mkdir -p "$SESSION_DIR"

# Resolve the GitHub repo if not exported. PR mode needs it for `gh pr view/diff`.
GH_REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"

# Detect default branch — don't assume `main`.
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"      # fallback only if detection fails.

# Both evaluators read live git state (codex review takes no diff-file flag).
# Abort on dirty working tree to prevent two trap classes:
#   (a) checkout silently carrying uncommitted work onto the PR-head SHA, OR
#   (b) the two evaluators disagreeing because unrelated working-tree changes
#       altered what `git diff` returns between Stage 1a and Stage 1b.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "abort: working tree has uncommitted changes — commit or stash first." >&2
  echo "       both evaluators read live git state; dirty trees give incoherent reviews." >&2
  exit 1
fi

# Capture the current branch so we can return after PR-mode checkout (which goes detached).
START_REF=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse HEAD)

if [ "$PR_NUM" = "branch" ]; then
  BASE="$DEFAULT_BRANCH"
  git diff "$BASE" > "$SESSION_DIR/diff.txt"
else
  BASE=$(gh pr view "$PR_NUM" --repo "$GH_REPO" --json baseRefName -q .baseRefName)
  HEAD_SHA=$(gh pr view "$PR_NUM" --repo "$GH_REPO" --json headRefOid -q .headRefOid)

  # Check out the PR head so both evaluators see the same change set.
  # Lands in detached-HEAD state; return path is `git switch -` or `git checkout "$START_REF"`.
  git fetch origin "+refs/pull/${PR_NUM}/head:refs/remotes/origin/pr/${PR_NUM}"
  git checkout "$HEAD_SHA"

  gh pr diff "$PR_NUM" --repo "$GH_REPO" > "$SESSION_DIR/diff.txt"
fi

# After Stage 4 (or on early exit), restore the original branch:
#   git checkout "$START_REF"
```

**Working-tree contract:** both evaluators read live git state. The captured `diff.txt` is for audit only. The Setup stage above enforces this contract by aborting on a dirty tree and (for PR mode) checking out the PR head SHA before either evaluator runs. Skip Setup at your own risk — a dirty tree produces incoherent reviews.

If the captured diff is empty, tell the user there's nothing to review and stop.

---

## Stage 1a: Claude `code-evaluator` subagent (project-aware)

Spawn the `code-evaluator` subagent. **Before passing the prompt to the Task tool, the invoking agent must substitute `$SESSION_DIR` with the resolved absolute path** — subagents run in their own context and don't inherit shell variables from the invoker. The same goes for any other shell var below.

Prompt template (substitute `$SESSION_DIR` and `$DIFF_PATH` before dispatch):

```
Review the diff at <SESSION_DIR>/diff.txt for correctness, error paths,
tests, naming, and architectural fit against project CLAUDE.md and
.claude/rules/.

For each finding, write:

## <severity>: <one-line summary>
**File:** path:line
**Issue:** specific problem
**Suggested fix:** concrete change

Severities: BLOCKER / SHOULD-FIX / NIT.

End with `LGTM` if no findings.

Write your output to <SESSION_DIR>/claude-review.md.
```

This runs in parallel with Stage 1b (don't wait).

## Stage 1b: Codex review

```bash
if [ -z "$FALLBACK" ]; then
  # Always use --base to evaluate the FULL diff (not just the tip commit).
  # Multi-commit PRs would otherwise have Stage 1a (full PR diff) and Stage 1b
  # (tip commit only) reviewing different change sets, breaking reconciliation.
  codex review --base "$BASE" > "$SESSION_DIR/codex-review.md" 2>&1
fi
```

For PR mode, the Setup stage already checked out the PR head — `--base "$BASE"` then evaluates HEAD..base, which is the full PR diff. For branch mode, working tree is at the branch tip, same outcome.

Codex output is free-form text, not structured. The reconciliation stage parses it.

Run in parallel with Stage 1a.

---

## Stage 2: Reconciliation

Once both finish, read both files and produce a merged punch list.

Reconciliation prompt for the invoking agent (no separate subagent):

```
Read $SESSION_DIR/claude-review.md and $SESSION_DIR/codex-review.md.

Produce a merged punch list at $SESSION_DIR/merged.md with this structure:

## Both flag (high confidence)
- file:line — issue summary
  - Claude: <quote>
  - Codex: <quote>

## Claude only (project-rule signal)
- file:line — issue summary
  - Claude: <quote>
  - Codex: silent — likely tuned-in to project convention Codex doesn't know.

## Codex only (blind-spot signal — investigate)
- file:line — issue summary
  - Codex: <quote>
  - Claude: silent — investigate whether this is a real blind spot or a generic
    rule that doesn't apply to this project.

Where Codex and Claude flag overlapping issues with different framing,
combine them under "Both flag" with both quotes preserved.
```

The invoking agent does this reconciliation in its own context (cheap; no subagent spawn). The output is a single file the agent reads next.

---

## Stage 3: Disciplined triage

For each finding in `$SESSION_DIR/merged.md`, the invoking agent explicitly classifies:

- **FIX** — apply the change now in a fix-commit. Append to `$SESSION_DIR/triage.md` as `FIX: <file:line> — <reason>`.
- **DISMISS** — finding is not applicable to this project / context / change. Append to `$SESSION_DIR/triage.md` as `DISMISS: <file:line> — <reason>`. The reason is mandatory — "doesn't apply" is not a reason; "Codex flags missing null-check on `req.userId` but the type guard at line 12 already proved it non-null" is.
- **ESCALATE** — finding is real but the right resolution requires Saurav input. Append to `$SESSION_DIR/triage.md` as `ESCALATE: <file:line> — <question>`. Surface via Telegram or boss-relay.

**Why disciplined dismissal matters:**

Without explicit classification, the agent oscillates: Codex says remove, Claude says keep, agent removes, next cycle Codex re-flags as missing, agent restores. Infinite loop, zero progress. The triage file is the audit record that lets you see "we already considered and dismissed this" without re-litigating.

If the same finding gets dismissed twice across separate dual-review runs on the same code, escalate to Saurav — repeated dismissal of the same flag is a smell.

---

## Stage 4: Apply fixes + commit

Apply all FIX-classified findings in one fix-commit:

```bash
# git add -u stages tracked files only — keeps reviews/ session artifacts out
# of the fix-commit (the .gitignore from Prerequisites also prevents accidents).
git add -u
git commit -m "$(cat <<EOF
fix: dual-review feedback

Addresses N findings flagged by Claude code-evaluator and/or Codex.
Triage: $SESSION_DIR/triage.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

ESCALATE findings stay open until Saurav responds. DISMISS findings are recorded but require no action.

---

## Output structure

After running, the session dir contains:

```
reviews/dual-<PR>-<DATE>/
  diff.txt              # the diff that was reviewed
  claude-review.md      # raw Claude code-evaluator output
  codex-review.md       # raw Codex review output (or empty if FALLBACK)
  merged.md             # reconciled punch list (Both / Claude-only / Codex-only)
  triage.md             # FIX / DISMISS-with-reason / ESCALATE classifications
```

This is the audit trail. Future dual-reviews on the same code can grep `triage.md` files to see prior dismissals.

---

## Cost notes

- Claude `code-evaluator` subagent: one Claude call. Counts against the agent's context budget.
- Codex review: one OpenAI API call (or ChatGPT subscription quota).
- Total per run: ~2 evaluator calls. Reserve for milestones, not every commit.
- For large diffs (>1000 lines), consider running `code-evaluator` per-file instead of on the whole diff. Codex handles large diffs better; it's optimized for full-PR review.

---

## Anti-patterns

- **Running dual-review on every commit.** Cost compounds; LGTM rate drops to noise. Use per-milestone.
- **Applying all Codex suggestions without dismissal review.** The oscillation trap — Codex doesn't know your project conventions; some of its "fixes" make your code less consistent.
- **Skipping the triage stage.** Without explicit FIX/DISMISS/ESCALATE classification, the audit record is missing and the next run re-litigates everything.
- **Running dual-review then only acting on Claude's output.** Defeats the purpose; you spent the Codex call for nothing.
- **Treating Codex silence as approval.** Codex didn't read your CLAUDE.md; it doesn't know what to flag. Silence from Codex on a project-rule violation isn't agreement, it's ignorance.
- **Treating Claude silence as approval on cross-project patterns.** Claude over-tunes to project convention; some generic anti-patterns get normalized as "the way we do it here."

---

## Source

- OpenAI Codex CLI: `codex review` subcommand (https://developers.openai.com/codex/cli)
- Boris Cherny's reference to dual-evaluator pattern (`codex review --base main` alongside Claude review)
- Disciplined dismissal discipline: Jökull Sólberg's `/babysit-pr` workflow
- Related: `.claude/agents/code-evaluator.md` (project's per-phase evaluator), `.claude/agents/pr-deep-evaluator.md` (PR-level evaluator)
