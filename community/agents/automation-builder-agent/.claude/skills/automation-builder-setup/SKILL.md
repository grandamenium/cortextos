---
name: automation-builder-setup
description: "Interactive setup for a tool-agnostic automation builder agent. Run on first boot or when the user says /setup."
---

# Automation Builder Setup

Configure the agent to discover repetitive workflows, map tools, design automations, create safe implementation plans, verify locally, and hand off implementation work.

Run this on first boot, when the user says `/setup`, or when `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is missing.

## Rules

- Ask questions in small batches and wait for the user when answers are required.
- Never request secrets in chat. Record missing credentials as human tasks.
- Do not execute production automations, external sends, deployments, purchases, account changes, or data deletion during setup.
- Prefer local files and dry-runs until the user approves an external connector.

## Discovery

```bash
for cmd in gog gh agent-browser jq rg python3 node npm n8n zapier pipedream; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'ZAPIER|MAKE|N8N|PIPEDREAM|GOOGLE|NOTION|AIRTABLE|SLACK|DISCORD|GITHUB|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
```

## Create Visible Setup Work

```bash
TASK_ID=$(cortextos bus create-task "Set up automation builder agent" --desc "Initialize automation registry, schemas, examples, crons, memory, goals, heartbeat, and onboarding marker.")
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "running automation-builder setup"
cortextos bus log-event task task_created info --meta '{"task_id":"'"$TASK_ID"'","agent":"'"$CTX_AGENT_NAME"'"}'
```

## Ask

1. What repetitive workflows waste time?
2. Which tools are involved?
3. What trigger starts each workflow?
4. What output/action should happen?
5. What requires approval before running?
6. What failure would be dangerous?
7. Should automations be no-code, scripts, MCP/CLI, browser automation, or agent-run crons?
8. Which specialists should receive handoffs: coding for implementation, PM for rollout, KB for docs, support/sales for domain workflows?
9. Which environments are safe for dry-run only, staging, and production?
10. What should always require human approval?

## Initialize Files

Create or verify these paths:

```bash
mkdir -p automations/specs automations/runbooks automations/handoffs automations/runs automations/schemas automations/examples memory tmp
test -f automations/registry.json || cp automations/examples/registry.example.json automations/registry.json
test -f GOALS.md || touch GOALS.md
test -f MEMORY.md || touch MEMORY.md
```

Required assets that should already exist in the template:

- `automations/schemas/automation-registry.schema.json`
- `automations/schemas/automation-spec.schema.json`
- `automations/schemas/runbook.schema.json`
- `automations/schemas/handoff.schema.json`
- `automations/schemas/run-record.schema.json`
- `automations/examples/local-file-inbox-summary.spec.json`
- `automations/examples/local-file-inbox-summary.runbook.json`
- `automations/examples/local-file-inbox-summary.handoff.json`
- `automations/examples/local-file-inbox-summary.run-record.json`

## Configure Crons

Confirm or add persistent crons with the `cron-management` skill:

```bash
cortextos bus list-crons $CTX_AGENT_NAME
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h Read HEARTBEAT.md and AGENTS.md. Update heartbeat, inbox, tasks, memory, blocked automation review, and next safe action.
cortextos bus add-cron $CTX_AGENT_NAME automation-backlog-review "0 10 * * 1-5" Review automations/registry.json and specs for stale candidates, missing blockers, and next local-first actions.
cortextos bus add-cron $CTX_AGENT_NAME runbook-quality-review "0 11 * * 5" Review runbooks for tests, rollback, observability, owner, approval gates, and credential blockers.
```

If a cron already exists, do not duplicate it; update only if the user approves schedule changes.

## First Automation Candidate

If the user has no candidate yet, use the bundled local-first example as the first backlog item:

- Request: summarize local `.txt` files from an inbox directory into a markdown digest.
- Target: local script or CLI workflow.
- External side effects: none.
- Verification: fixture directory and dry-run output.

## Completion

Setup is not complete until all of these are done:

1. `automations/registry.json` exists and validates against the registry schema.
2. `automations/specs`, `automations/runbooks`, `automations/handoffs`, `automations/runs`, and `automations/schemas` exist.
3. The bundled local-first example exists and can be used as a smoke fixture.
4. `GOALS.md`, `MEMORY.md`, and daily memory are initialized or updated.
5. Heartbeat is updated and setup events are logged.
6. A setup task is completed with a concise result.
7. `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is touched.

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
printf '\n## Setup - %s UTC\n- Initialized automation-builder assets, crons, registry, schemas, and local-first example.\n' "$(date -u +%H:%M:%S)" >> "memory/$TODAY.md"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus update-heartbeat "automation-builder setup complete"
cortextos bus complete-task "$TASK_ID" --result "Initialized automation-builder operating files, schemas/examples, registry, recurring reviews, memory, and onboarding marker."
cortextos bus log-event action workflow_completed info --meta '{"workflow":"automation-builder-setup","agent":"'"$CTX_AGENT_NAME"'"}'
```
