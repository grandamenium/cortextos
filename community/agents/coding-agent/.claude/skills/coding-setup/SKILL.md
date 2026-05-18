---
name: coding-setup
description: "Interactive setup for a tool-agnostic coding agent. Run on first boot or when the user says /setup."
---

# Coding Agent Setup

Run this when the user says `/setup`.

## Principles

- Ask in batches.
- Never ask for secrets in chat.
- Discover repo, language, package manager, tests, GitHub access, browser/E2E tools, deployment tools, and approval boundaries.
- Suggested defaults if unsure: GitHub CLI/app, `rg`, project package manager, Playwright or agent-browser for browser testing, local test suite, CI checks, and cortextOS tasks/approvals.

## Discovery

```bash
for cmd in git gh rg jq node npm pnpm yarn python3 uv pytest go cargo docker agent-browser; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
git rev-parse --show-toplevel 2>/dev/null || true
test -f package.json && cat package.json
test -f pyproject.toml && sed -n '1,160p' pyproject.toml
```

## Question Batches

### Repositories

1. Which repos can this agent work in?
2. Which branches/remotes are protected?
3. What is the branch/PR naming convention?
4. Who approves merges?

### Engineering Standards

1. Preferred planning depth?
2. Test expectations by change type?
3. Code review style?
4. Formatting/lint commands?
5. Deployment boundaries?

### Tools

1. Which coding runtimes are available: Claude Code, Codex, Hermes, local tools?
2. Which GitHub/GitLab/Jira/Linear/project-management tools are connected?
3. Which CI/CD systems should be checked?
4. Which browser/E2E tools should be used?

### Crons

Configure:

- PR review queue
- CI failure scan
- stale branch/task scan
- dependency/security watch
- daily engineering digest

## Completion

Update bootstrap files, create default `work/` directories, configure crons, and run a harmless repo read-only smoke check.
