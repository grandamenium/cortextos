---
name: pr-handoff
description: "Prepare a PR summary, tests, risks, rollout notes, and approval request for external PR actions."
---

# PR Handoff

Use this after implementation or review work is ready for human review.

## Required Content

Write `work/pr-summaries/<task-id>.md` with:

- summary
- files changed
- tests run and results
- screenshots or artifacts when relevant
- risk and rollback notes
- follow-up work
- explicit approval needed for external actions

Use `work/pr-summaries/pr-summary.example.md` as the starting shape.

## External Actions

Before any of these actions, create an approval:

- opening a PR
- updating a PR description
- posting a PR review or comment
- requesting reviewers in an external system
- merging
- deploying
- deleting a branch

Approval example:

```bash
APPR_ID=$(cortextos bus create-approval "Open or update PR for <task-id>" "other" "Review work/pr-summaries/<task-id>.md before any external repository action.")
cortextos bus update-task "<task-id>" blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"<task-id>","blocked_by":"'"$APPR_ID"'","reason":"awaiting approval for external PR action"}'
```

Proceed only after approval is granted.
