---
name: automation-runbook
description: "Write implementation-ready runbooks for automations, including safety gates and test plans."
---

# Automation Runbook

Use this after an automation spec exists.

Every runbook includes:

- purpose and scope
- trigger
- target platform
- tools and permissions
- credential status without secret values
- data flow
- local dry-run path
- approval gates
- implementation steps
- observability and run logs
- error handling
- rollback
- tests
- maintenance owner

## Output

Write `automations/runbooks/<automation-id>.json` matching `automations/schemas/runbook.schema.json`.

If the runbook needs missing credentials, paid services, connector setup, production access, or human policy decisions, do not continue silently. Use `.claude/skills/human-tasks/SKILL.md` or `.claude/skills/approvals/SKILL.md` and record the blocker in the registry.

## Local Verification

Where feasible, create a dry-run record in `automations/runs/<automation-id>-<date>.json` matching `automations/schemas/run-record.schema.json`.

Local verification can use fixture files, mocked API payloads, dry-run CLI flags, staging destinations, or read-only previews. Production mutation requires approval.
