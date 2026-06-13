---
name: handoff-to-starter-agent
description: "Write approval-safe handoff docs and first tasks for approved starter agents."
---

# Handoff to Starter Agent

Use this only after the user has approved the starter team. Do not install templates or create agents from this skill unless the approval explicitly covers the exact agents and templates.

## Handoff File

For each approved agent, write `concierge/handoffs/<agent-name>.md` with:

- agent/template name
- why this agent exists
- user outcome it serves
- first task
- relevant local files
- available tools
- missing credentials and human tasks
- approval gates
- boundaries and never-touch list
- success criteria
- reporting cadence

## First Task

Create the first task for the starter agent only after it exists. If it does not exist yet, write the task draft in the handoff file and leave execution blocked on approval/creation.

## Safe Commands

After approval, use the documented install/add-agent commands for the local cortextOS version. Verify the resulting agent contains its template files, not a generic fallback.

Never broaden the approval. If the approval covers one agent, create only that agent.
