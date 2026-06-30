---
name: coding-setup
description: "Interactive setup for a tool-agnostic coding agent. Run on first boot or when the user says /setup."
---

# Coding Agent Setup

Run this when the user says `/setup` or when onboarding discovers `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is missing.

## Principles

- Ask in batches.
- Never ask for secrets in chat.
- Discover repo, language, package manager, tests, GitHub access, browser/E2E tools, deployment tools, and approval boundaries.
- Suggested defaults if unsure: GitHub CLI/app, `rg`, project package manager, Playwright or agent-browser for browser testing, local test suite, CI checks, and cortextOS tasks/approvals.
- Local files are the source of truth until external systems are explicitly configured.
- Publishing, merging, deploying, public comments, and any real external side effect require approval.

## Setup Task

Create a visible setup task before making changes:

```bash
SETUP_TASK_ID=$(cortextos bus create-task "Set up coding agent" --desc "Configure repositories, policies, work directories, crons, memory, goals, and onboarding marker for this coding agent." | awk '/task_/ {print $NF}' | tail -1)
test -n "$SETUP_TASK_ID" && cortextos bus update-task "$SETUP_TASK_ID" in_progress
cortextos bus log-event task task_created info --meta '{"task_id":"'"$SETUP_TASK_ID"'","agent":"'"$CTX_AGENT_NAME"'","template":"coding-agent"}'
```

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
5. Should the agent use worktrees, in-place branches, or repo-specific policy?

### Engineering Standards

1. Preferred planning depth?
2. Test expectations by change type?
3. Code review style?
4. Formatting/lint commands?
5. Deployment boundaries?
6. Files, paths, or data classes the agent must never edit or publish?

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

## Create Operating Assets

Initialize local-first files. If the user gave concrete answers, replace placeholders with those answers. If they did not, keep conservative defaults and mark follow-ups in `GOALS.md`.

```bash
mkdir -p coding work/reviews work/ci work/patches work/pr-summaries work/tasks work/worktrees memory outputs

test -f coding/repositories.json || cp coding/repositories.example.json coding/repositories.json
test -f coding/policies.json || cp coding/policies.example.json coding/policies.json

cat > GOALS.md <<'EOF'
# Goals

Current focus: finish coding-agent setup and confirm repository access.

Default goals:

1. Implement assigned code changes safely.
2. Review PRs and surface concrete defects.
3. Run appropriate tests and record evidence.
4. Prepare clean branches, patch notes, and PR summaries for human approval.
5. Keep tasks, memory, heartbeat, and events current.

Open setup questions:

- Confirm allowed repositories and branch policy.
- Confirm test/lint commands per repository.
- Confirm approval owners for PR publishing, merges, deploys, and external comments.
EOF

cat > MEMORY.md <<'EOF'
# Long-Term Memory

Setup initialized this coding agent with local-first repository and policy files.

Durable repo rules, project patterns, commands, user preferences, approval boundaries, and engineering lessons should be added here after they are learned.
EOF

cat > SYSTEM.md <<EOF
# System Context

Runtime: ${CTX_RUNTIME:-configured by cortextOS}
Agent: ${CTX_AGENT_NAME:-coding-agent}
Org: ${CTX_ORG:-unknown}
Timezone: ${CTX_TIMEZONE:-local}

This agent is tool-agnostic and may use Claude Code, Codex, GitHub/GitLab tooling, local test runners, and browser/E2E tools when configured.
EOF

cat > USER.md <<'EOF'
# User Profile

Filled during setup.

Store non-secret engineering preferences, repository rules, reporting style, approval owners, and communication preferences here.
EOF

cat > TOOLS.md <<'EOF'
# Tools

Configured during setup.

Suggested defaults:

- `git`, `rg`, `jq`, and project package managers.
- GitHub CLI/app or GitLab tooling when configured.
- Local language test runners and CI logs.
- agent-browser, Playwright, Cypress, or project-native browser tooling for E2E checks.
- cortextOS tasks, approvals, human tasks, heartbeat, memory, and event logging.

Never store secrets here.
EOF
```

## Configure Crons

Use daemon-managed crons only. Do not use session-local `/loop` for persistent work.

Recommended crons:

```bash
cortextos bus add-cron "$CTX_AGENT_NAME" heartbeat "4h" "Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox/tasks, write memory, and continue the highest-priority safe coding task."
cortextos bus add-cron "$CTX_AGENT_NAME" coding-pr-review-queue "0 10 * * 1-5" "Review configured PR queues from coding/repositories.json. Draft findings only; request approval before posting externally."
cortextos bus add-cron "$CTX_AGENT_NAME" coding-ci-scan "30 10 * * 1-5" "Scan configured CI failures and record notes in work/ci/. Create tasks for actionable failures."
```

If a cron already exists, update it with the `cron-management` skill instead of creating duplicates.

## Happy Path Smoke

After setup, walk one local-only happy path without publishing externally:

1. Create a cortextOS task for a small repo change or review.
2. Select the repo from `coding/repositories.json`.
3. Create or confirm a branch/worktree according to policy.
4. Run the configured narrow tests or a read-only smoke command.
5. Prepare patch notes in `work/patches/`.
6. Draft a PR summary in `work/pr-summaries/`.
7. Create an approval request before opening/updating a real PR, posting a comment, merging, or deploying.

## Completion

Complete setup only after assets exist and onboarding is marked:

```bash
cortextos bus update-heartbeat "setup complete; ready for coding tasks"
cortextos bus log-event action workflow_completed info --meta '{"workflow":"coding-agent-setup","agent":"'"$CTX_AGENT_NAME"'"}'
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
test -n "$SETUP_TASK_ID" && cortextos bus complete-task "$SETUP_TASK_ID" --result "Initialized coding-agent repository registry, policies, work directories, goals, memory, heartbeat, events, and onboarding marker."
test -n "$SETUP_TASK_ID" && cortextos bus log-event task task_completed info --meta '{"task_id":"'"$SETUP_TASK_ID"'","agent":"'"$CTX_AGENT_NAME"'"}'
```

Then summarize:

- allowed repositories
- branch/worktree policy
- test and lint commands
- approval boundaries
- crons configured
- open setup questions
