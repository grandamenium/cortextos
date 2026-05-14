---
name: framework-upstream-auto-update
effort: low
description: "Daily upstream framework auto-update workflow. Fetches new cortextos commits, classifies by type and touched paths, auto-applies safe bug fixes, routes features/mixed to [ORCHESTRATOR] for approval, and verifies the apply with build + test before reporting."
triggers: ["upstream check", "framework update", "check upstream", "upstream auto-update", "framework upstream", "apply upstream", "sync upstream"]
---

# Framework Upstream Auto-Update

## Trigger
- Daily cron (see `config.json` crons entry `daily-framework-upstream-auto-update`).
- Ad hoc if [ORCHESTRATOR] or a user asks for an upstream check.

## Owner
[AGENT_NAME] owns upstream framework health for the cortextos workspace. Bug fix application authority should be documented in your MEMORY.md or deployment config. Feature-level changes always route to [ORCHESTRATOR], who routes to the user for approval.

## Inputs
- Framework repo: the cortextos workspace root (the `CTX_ROOT` parent — the git repo, not the state dir)
- Upstream: `upstream/main` (verify with `git remote -v` if unsure)
- Current local state: local main can run ahead of upstream (your local fixes may flow upstream). Do NOT try to "sync" ahead-commits downward.

## Procedure

### Step 1 — Fetch and inspect
```bash
cd /path/to/cortextos
cortextos bus check-upstream
```
Read the output. If it reports no new commits, skip to Step 7 (log noop and stop).

If there are new commits, list them:
```bash
git fetch upstream main
git log --oneline HEAD..upstream/main
```

### Step 2 — Classify each commit
For each new commit, read the subject and the diff:
```bash
git show --stat <sha>
git show <sha>
```

Classification buckets:

| Bucket | Subject patterns | Action |
|---|---|---|
| **bugfix** | `fix(...)`, `hotfix(...)`, `fix:`, `BUG-###`, `closes BUG-###` | Auto-apply if safe paths |
| **docs/chore** | `docs:`, `chore:`, `test:`, `refactor:`, `ci:`, `build:` | Auto-apply if safe paths |
| **feature** | `feat(...)`, `feat:`, `new:` | Do NOT apply. Route to [ORCHESTRATOR] for approval. |
| **mixed** | Any commit that contains multiple fix/feat changes or that is ambiguous | Route to [ORCHESTRATOR]. |

### Step 3 — Check touched paths (HARD GUARDRAIL)
For EVERY new commit, scan the diff for touched paths. If ANY of the new commits touch any of these paths, **do NOT auto-apply anything**, flag the whole batch to [ORCHESTRATOR], and stop:

- `orgs/` — multi-tenant configuration, never auto-merge
- `**/.env*` — credentials and secrets
- `**/memory/` (agent memory subfolders)
- `**/MEMORY.md` (agent-level long-term memory)
- `community/skills/` — community skill catalog changes that affect running agents
- `community/agents/` — community agent templates that affect running agents

When flagging: collect the commit SHAs, commit messages, and touched paths, and send them to [ORCHESTRATOR] via `cortextos bus send-message [ORCHESTRATOR] normal '<summary>'`. Do not apply.

### Step 4 — Apply safe bugfix / docs / chore commits
If all new commits are pure bugfix or docs/chore AND none touch the guardrail paths:
```bash
cd /path/to/cortextos
CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes cortextos bus check-upstream --apply
```
**The `CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes` env var is required.** Without it, `check-upstream --apply` returns `{"status": "error", "error": "Refusing to auto-merge upstream..."}` as a safety gate. The env var is the "I have reviewed the diff and I trust the changes" signal. Set it inline, not exported, so it does not leak into subsequent unrelated commands.

After applying:
```bash
cd /path/to/cortextos
npm run build
npm test
```
Both must succeed. If either fails, DO NOT revert silently — report the failure to [ORCHESTRATOR] with the full error output and wait for instructions. The framework remains in its applied state; [ORCHESTRATOR] will decide whether to revert or patch.

### Step 5 — Handle feature or mixed batches (no apply)
If any new commit is feature or mixed but all paths are safe:
- Do NOT run `--apply`
- Send [ORCHESTRATOR] a summary message containing:
  - Commit list (SHA + subject)
  - Touched paths (de-duped)
  - Your recommendation: apply as-is, hold for user review, or request clarification
- Wait for [ORCHESTRATOR] to route to the user. The cron exits after sending the message.

### Step 6 — Report to [ORCHESTRATOR] on success
When a bugfix batch is successfully applied and the build + tests are green:
```bash
cortextos bus send-message [ORCHESTRATOR] normal 'Framework upstream auto-update YYYY-MM-DD: applied N commits. Build + test green. Details: ...'
```
Include the commit list and any interesting touched paths (e.g. dist/cli.js rebuilt, specific src/ modules touched).

### Step 7 — Log and record (run this step ALWAYS, even for noop)
```bash
cortextos bus create-task "framework-upstream-check $(date +%Y-%m-%d)" --desc "Daily upstream check. Result: <applied N / flagged M / skipped K / noop>"
cortextos bus log-event action framework_updated info --meta '{"applied":N,"flagged":M,"skipped":K,"noop":BOOL}'
```

Write a single-line entry to today's daily memory file describing the result.

### Step 8 — Morning briefing hook
Include whatever was applied or flagged overnight from Step 7's memory entry in the next morning brief. Users should see the result in their morning summary, not have to ask.

## Failure Modes
- **Network failure fetching upstream** → log a warning event, do not retry in-loop, wait for next day's run.
- **Merge conflict during apply** → do NOT force. Report to [ORCHESTRATOR] with the conflict details and stop. [ORCHESTRATOR] + user will resolve by hand.
- **Build or test failure after apply** → do NOT auto-revert. Report to [ORCHESTRATOR] with full error output. [ORCHESTRATOR] decides whether to revert, patch, or tolerate.
- **Unexpected touched path (new guardrail category)** → flag to [ORCHESTRATOR], propose the new path for the guardrail list, wait for confirmation before adding it to this SKILL.

## Deployment Config

Add to `config.json` crons:
```json
{
  "name": "daily-framework-upstream-auto-update",
  "interval": "24h",
  "prompt": "Read and follow .claude/skills/framework-upstream-auto-update/SKILL.md"
}
```

Replace `[AGENT_NAME]` and `[ORCHESTRATOR]` with your agent's name and the orchestrator agent name in your deployment.

## Notes
- Local main is allowed to run ahead of upstream. `check-upstream` handles this correctly.
- Never push to upstream as part of this flow. Push is a separate manual operation.
- Bug fix application authority belongs to the user and should be granted explicitly in your deployment config or MEMORY.md.
