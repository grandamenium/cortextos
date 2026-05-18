---
name: project-manager-setup
description: "Interactive setup for a tool-agnostic project manager agent. Run on first boot or when the user says /setup."
---

# Project Manager Setup

Configure this agent as the user's execution operating system.

## Discovery

```bash
for cmd in gh gog agent-browser jq rg; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'LINEAR|JIRA|GITHUB|NOTION|ASANA|CLICKUP|TRELLO|GOOGLE|SLACK|DISCORD' | sed 's/=.*/=<configured>/'
cortextos bus list-agents
```

## Ask in Batches

1. Projects: active projects, outcomes, owners, deadlines, priority order.
2. Task system: cortextOS only, Linear/Jira/GitHub/Notion/Asana/etc, or local-first sync.
3. Cadence: daily standup, blocker review, weekly review, stakeholder report, stale-task nudge.
4. Reporting: concise Telegram, markdown reports, dashboard tasks, shared docs, agent messages.
5. Handoffs: coding to `coding-agent`, research to `research-agent`, KB gaps to `knowledge-base-librarian`, automations to `automation-builder-agent`, sales/support to those specialist agents.

## Completion

Update bootstrap files, initialize `projects/`, create first project registry, add crons for reviews, and create tasks for the top three active projects.
