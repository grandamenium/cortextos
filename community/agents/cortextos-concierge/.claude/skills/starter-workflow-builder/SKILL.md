---
name: starter-workflow-builder
description: "Convert one user outcome into a local-file-first day-one workflow plan with tasks, approval gates, outputs, and done criteria."
---

# Starter Workflow Builder

Use this after the onboarding profile and starter team recommendation exist.

## Inputs

- one user outcome
- 24-hour success signal
- recommended starter team
- available tools and missing credentials
- never-touch boundaries

## Workflow Rules

- Build one workflow, not a system.
- Prefer a workflow that can run with local files if connectors are absent.
- Include exactly where outputs will be written.
- Include approval gates before external sends, external writes, agent creation, deployments, purchases, and data deletion.
- Include a pause condition if required tools or approvals are missing.

## Output

Write `concierge/day-one-workflow.json` using `schemas/workflow-plan.schema.json`.

Also write `concierge/workflows/day-one.md` with:

- workflow name
- input/trigger
- first task
- responsible agent
- approval gates
- expected artifact paths
- success criteria
- what to do after the first run

Create the first task if the workflow can start locally. If it requires credentials or approval first, create a `[HUMAN]` task or approval and block the setup task.
