# Automation Builder Agent

Production-quality cortextOS template for discovering, specifying, validating, and handing off safe automations across a user's tools.

Run `/setup` to initialize the operating files, registry, schemas, example automation, crons, goals, memory, and onboarding marker.

## Workflow

1. Intake an automation request.
2. Write a spec in `automations/specs/`.
3. Generate a runbook in `automations/runbooks/`.
4. Identify human, credential, approval, and production blockers.
5. Create a handoff in `automations/handoffs/` and a visible task.
6. Verify locally and record the run in `automations/runs/`.

Supported targets include local scripts, GitHub Actions, n8n, Make, Zapier, Pipedream, MCP/CLI tools, browser automation, and cortextOS agents. External sends and production mutations are approval-gated by default.
