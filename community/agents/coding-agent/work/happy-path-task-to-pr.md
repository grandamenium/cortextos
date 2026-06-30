# Happy Path: Task to PR Summary

This is a local-first smoke path for a spawned coding agent. It must not publish, post, merge, or deploy without approval.

## 1. Create or Acknowledge Task

```bash
TASK_ID=$(cortextos bus create-task "Fix small repository issue" --desc "Use the coding-agent happy path: select repo, branch/worktree, test, patch, PR summary, and approval gate." | awk '/task_/ {print $NF}' | tail -1)
cortextos bus update-task "$TASK_ID" in_progress
```

## 2. Select Repository and Policy

Read:

- `coding/repositories.json`
- `coding/policies.json`

Proceed only if the repository has `"allowed": true`. If it is not allowed or policy is ambiguous, ask the user or create a human task.

## 3. Create Branch or Worktree

Example for worktree policy:

```bash
SLUG=small-fix
BRANCH="agent/${TASK_ID}-${SLUG}"
git -C "$REPO_PATH" fetch --all --prune
git -C "$REPO_PATH" worktree add "work/worktrees/${BRANCH//\\//-}" -b "$BRANCH" origin/main
```

Use the configured default branch and worktree root for the selected repository.

## 4. Run Tests

Run the narrowest relevant configured test first:

```bash
git -C "$WORKTREE_PATH" status --short
git -C "$WORKTREE_PATH" diff --check
# then the repository-specific lint/unit/typecheck command from coding/repositories.json
```

Record results in `work/ci/<task-id>.md`.

## 5. Record Patch

Write `work/patches/<task-id>.md` with:

- intent
- files changed
- tests run
- risks
- rollback notes

## 6. Draft PR Summary

Write `work/pr-summaries/<task-id>.md` with:

- summary
- tests
- risk
- approval needed for external action

## 7. Approval Gate

Before creating or updating a real PR, posting a review comment, merging, deploying, deleting branches, or sending any external message:

```bash
APPR_ID=$(cortextos bus create-approval "Open PR for $TASK_ID" "other" "Review work/pr-summaries/$TASK_ID.md and approve before any external GitHub/GitLab action.")
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"'"$TASK_ID"'","blocked_by":"'"$APPR_ID"'","reason":"awaiting approval for external PR action"}'
```

Resume only after approval is granted.
