---
name: customer-support-setup
description: "Interactive setup for a tool-agnostic customer support agent. Run on first boot or when the user says /setup."
---

# Customer Support Setup

Configure support inboxes, product/docs sources, triage taxonomy, response rules, escalation paths, and reporting cadence.

Run this on first boot, when the user says `/setup`, or when `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is missing.

## Rules

- Ask questions in small batches and stop for the user when answers are required.
- Never ask for secrets in chat. Record missing credentials as human tasks.
- Do not send customer replies, mutate external tickets, refund, charge, delete data, or change account access during setup.
- Prefer local files until the user explicitly enables an external connector.
- Customer sends are always approval-gated, even when a connector is configured.

## Discovery

```bash
for cmd in gog agent-browser gh jq rg python3 node npm; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'ZENDESK|INTERCOM|FRESHDESK|HELP_SCOUT|HELPSCOUT|LINEAR|JIRA|GITHUB|GMAIL|OUTLOOK|SLACK|DISCORD|NOTION|GOOGLE|SUPPORT' | sed 's/=.*/=<configured>/'
```

## Create Visible Setup Work

```bash
TASK_ID=$(cortextos bus create-task "Set up customer support agent" --desc "Initialize support config, macros, ticket intake, escalation policy, drafts, reports, KB gaps, crons, memory, goals, heartbeat, events, and onboarding marker.")
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "running customer-support setup"
cortextos bus log-event task task_created info --meta '{"task_id":"'"$TASK_ID"'","agent":"'"$CTX_AGENT_NAME"'"}'
```

## Ask

1. Which product/service does support cover?
2. Which inboxes/tools contain tickets or messages?
3. Where are source-of-truth docs?
4. What categories/priorities should be used?
5. What can be answered autonomously vs drafted for approval?
6. What requires escalation: billing, legal, security, refunds, bugs, angry customers, account access?
7. Where should bug/product feedback handoffs go?
8. Should FAQ/KB gaps go to `knowledge-base-librarian`?
9. What tone should macros use?
10. What SLA targets should be monitored?
11. Which actions always need approval? Keep customer sends on this list.

## Initialize Files

Create or verify these paths and starter files:

```bash
mkdir -p support/drafts support/reports support/kb-gaps support/schemas support/examples memory tmp "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
test -f support/config.json || cp support/examples/support-config.example.json support/config.json
test -f support/macros.md || cp support/examples/macros.example.md support/macros.md
test -f support/escalation-policy.json || cp support/examples/escalation-policy.example.json support/escalation-policy.json
test -f support/tickets.jsonl || cp support/examples/tickets.example.jsonl support/tickets.jsonl
test -f GOALS.md || touch GOALS.md
test -f MEMORY.md || touch MEMORY.md
```

Required assets that should already exist in the template:

- `support/schemas/support-config.schema.json`
- `support/schemas/ticket.schema.json`
- `support/schemas/macro.schema.json`
- `support/schemas/escalation-policy.schema.json`
- `support/schemas/draft.schema.json`
- `support/schemas/kb-gap.schema.json`
- `support/schemas/triage-report.schema.json`
- `support/examples/support-config.example.json`
- `support/examples/tickets.example.jsonl`
- `support/examples/macros.example.md`
- `support/examples/escalation-policy.example.json`
- `support/examples/draft.example.md`
- `support/examples/kb-gap.example.json`
- `support/examples/triage-report.example.md`

## Configure Connectors

Default connector mode is `local_files`.

Optional connectors are allowed only when configured by the user and credentials are present outside chat:

- Ticketing: Zendesk, Intercom, Freshdesk, Help Scout.
- Email: Gmail, Outlook.
- Engineering/product handoff: GitHub, Linear, Jira.
- Docs/KB: local docs, website exports, Notion/Drive exports, knowledge-base-librarian, cortextOS KB collections.

If a connector is requested but not configured, create a human task with exact setup instructions and continue with local files.

## Configure Crons

Confirm or add persistent crons with the `cron-management` skill:

```bash
cortextos bus list-crons $CTX_AGENT_NAME
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h Read HEARTBEAT.md and AGENTS.md. Update heartbeat, check inbox/tasks, review pending drafts, escalations, KB gaps, and continue the highest-priority safe support task.
cortextos bus add-cron $CTX_AGENT_NAME support-triage "0 9 * * 1-5" Create or update a support triage task, then run .claude/skills/ticket-triage/SKILL.md against support/tickets.jsonl or configured support queues. Draft replies only; do not send externally without approval.
cortextos bus add-cron $CTX_AGENT_NAME pending-drafts-review "0 15 * * 1-5" Review support/drafts, pending approvals, escalations, SLA risk, and stale tickets. Create follow-up tasks or reports; do not send externally without approval.
cortextos bus add-cron $CTX_AGENT_NAME weekly-kb-gap-review "0 11 * * 5" Run .claude/skills/support-kb-gap-review/SKILL.md. Review support/kb-gaps and reports for repeated issues, weak macros, missing docs, and product feedback.
```

If a cron already exists, do not duplicate it; update only if the user approves schedule changes.

## First Local Ticket

If there is no real queue yet, use `support/examples/tickets.example.jsonl` as the smoke fixture:

- Read one local ticket.
- Classify priority, category, sentiment, and escalation flags.
- Search local macros and config.
- Draft a reply to `support/drafts/example-ticket-001.md`.
- Create an approval request only if a real customer send is requested.
- Write a KB gap and triage report if the docs are incomplete.

## Completion

Setup is not complete until all of these are done:

1. `support/config.json`, `support/macros.md`, `support/tickets.jsonl`, and `support/escalation-policy.json` exist.
2. `support/drafts`, `support/reports`, `support/kb-gaps`, `support/schemas`, and `support/examples` exist.
3. Persistent crons are configured or intentionally deferred in the setup report.
4. `GOALS.md`, `MEMORY.md`, and daily memory are initialized or updated.
5. Heartbeat is updated and setup events are logged.
6. A setup task is completed with a concise result.
7. `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is touched.

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
printf '\n## Setup - %s UTC\n- Initialized customer-support assets, crons, local tickets, macros, escalation policy, reports, KB gaps, memory, and onboarding marker.\n' "$(date -u +%H:%M:%S)" >> "memory/$TODAY.md"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus update-heartbeat "customer-support setup complete"
cortextos bus complete-task "$TASK_ID" --result "Initialized customer-support operating files, schemas/examples, local ticket intake, macros, escalation policy, recurring reviews, memory, and onboarding marker."
cortextos bus log-event action workflow_completed info --meta '{"workflow":"customer-support-setup","agent":"'"$CTX_AGENT_NAME"'"}'
```
