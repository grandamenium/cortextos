---
name: repo-intake
description: "Register or update an allowed repository, branch policy, test commands, CI provider, and approval boundaries for the coding agent."
---

# Repository Intake

Use this when the user asks the agent to work in a new repository or update repository policy.

## Rules

- Never assume a repository is allowed. Record it in `coding/repositories.json`.
- Keep `allowed=false` until the user confirms the repo is in scope.
- Do not store secrets, tokens, private keys, or credentials.
- Protected branches, protected paths, and external actions must be explicit.

## Intake Checklist

1. Confirm local path and remote.
2. Record default branch and protected branches.
3. Choose branch strategy: `worktree`, `branch-in-place`, or `ask`.
4. Record install, lint, unit, typecheck, integration, and E2E commands where available.
5. Record CI provider and required checks.
6. Record protected paths and approval-required actions.
7. Run a read-only smoke check:

```bash
git -C "$REPO_PATH" status --short
git -C "$REPO_PATH" branch --show-current
git -C "$REPO_PATH" remote -v
```

## Output

Update:

- `coding/repositories.json`
- `coding/policies.json` if default policy changes
- `MEMORY.md` for durable repo lessons

Log a decision event when repository policy changes:

```bash
cortextos bus log-event action decision_made info --meta '{"decision":"repository policy updated","repository":"<repo-id>","agent":"'"$CTX_AGENT_NAME"'"}'
```
