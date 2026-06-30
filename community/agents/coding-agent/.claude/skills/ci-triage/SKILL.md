---
name: ci-triage
description: "Diagnose failing CI checks, reproduce locally when possible, and prepare fix notes without posting externally unless approved."
---

# CI Triage

Use this when CI is failing or the user asks for build/test debugging.

## Workflow

1. Create or acknowledge a task.
2. Identify the repository in `coding/repositories.json`.
3. Check the configured CI provider and required checks.
4. Collect failing check names, log excerpts, commit SHA, branch, and run URL.
5. Reproduce locally with the narrowest equivalent command where feasible.
6. Determine whether the failure is product code, test fixture, environment, flaky infrastructure, or missing credentials.
7. Record findings in `work/ci/<task-id>.md`.
8. If code changes are needed, switch to `implementation-workflow`.

## Approval Boundary

Draft comments and PR updates locally. Request approval before posting to GitHub, GitLab, Jira, Linear, Slack, email, or any other external system.

## CI Note Template

Use `work/ci/ci-note.example.md` as the starting shape for notes.
