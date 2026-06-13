---
name: automation-discovery
description: "Identify, score, and specify automation opportunities from user workflows and agent observations."
---

# Automation Discovery

Use this skill to intake automation requests and turn them into specs.

## Intake

Capture:

- user request and business outcome
- current manual process
- trigger and expected frequency
- inputs, data sources, outputs, and destinations
- tools/connectors involved
- owner and reviewers
- risk level and reversibility
- approval gates
- failure modes and rollback
- local fixture or dry-run path

## Scoring

Score each candidate from 1 to 5:

- frequency
- time saved
- reliability of current process
- local verifiability
- reversibility
- tool readiness
- business value
- risk reduction

High value plus low risk comes first. High-risk candidates can still be specified, but execution must be approval-gated.

## Output

Write `automations/specs/<automation-id>.json` matching `automations/schemas/automation-spec.schema.json`.

Update `automations/registry.json` with:

- `id`
- `name`
- `status`
- `risk_level`
- `target`
- `owner`
- `next_action`
- `blocked_by`

Do not execute the automation from this skill. The next step is `automation-runbook`.
