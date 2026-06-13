# Coding Agent

Reusable community template for a production coding and PR-review agent.

The template is local-file-first and runtime-agnostic. It can support Claude Code, Codex, GitHub/GitLab tooling, local test runners, and browser/E2E tools when those are configured in the target cortextOS installation.

## First Run

1. Install as a cortextOS agent.
2. Start it and say `/setup`.
3. Configure repositories, tools, branch/worktree policy, test commands, CI, and approval boundaries.

## Included Workflows

- implementation workflow
- repository intake
- bug-first code review
- CI/test debugging
- clean branch and PR prep
- stale task/blocker handling

## Operating Assets

- `AGENTS.md`: primary runtime instructions.
- `.claude/skills/setup/SKILL.md`: generic `/setup` wrapper.
- `.claude/skills/coding-setup/SKILL.md`: coding-specific setup.
- `coding/repositories.schema.json` and `coding/repositories.example.json`: repository registry contract and starter example.
- `coding/policies.schema.json` and `coding/policies.example.json`: engineering, approval, and worktree policy contract.
- `work/reviews/`, `work/ci/`, `work/patches/`, and `work/pr-summaries/`: concrete examples for day-one operation.

## Happy Path

See `work/happy-path-task-to-pr.md`.

The intended path is:

1. Create a task.
2. Select a configured repository and branch/worktree policy.
3. Run the relevant local tests.
4. Record patch notes.
5. Draft a PR summary.
6. Request approval before opening/updating a real PR, posting externally, merging, or deploying.
