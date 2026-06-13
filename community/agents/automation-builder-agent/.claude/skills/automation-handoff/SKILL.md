---
name: automation-handoff
description: "Package an automation spec and runbook into an implementation handoff with blockers, approval gates, tasks, and local verification requirements."
---

# Automation Handoff

Use this after an automation spec and runbook exist.

## Classify The Target

Choose the smallest viable implementation target:

- local script
- GitHub Actions
- n8n
- Make
- Zapier
- Pipedream
- MCP/CLI tool
- browser automation
- cortextOS agent workflow
- human-operated runbook

Document why the target is appropriate and what fallback exists if the preferred vendor is unavailable.

## Blocker Scan

Identify:

- missing credentials or connector authorization
- missing paid plan or account access
- missing data sample or fixture
- production mutation risk
- external send risk
- data deletion risk
- unclear owner or approval policy
- insufficient rollback or observability

Create human tasks for capability gaps and approvals for permission-gated actions. Do not execute external or production changes while blockers exist.

## Output

Write `automations/handoffs/<automation-id>.json` matching `automations/schemas/handoff.schema.json`.

Create or update a visible task for implementation, then set it to:

- `pending` if ready for an implementer
- `blocked` if waiting on a human task or approval
- `completed` only when local verification has a passing run record

Update `automations/registry.json` with the handoff path, task ID, blockers, and next action.
