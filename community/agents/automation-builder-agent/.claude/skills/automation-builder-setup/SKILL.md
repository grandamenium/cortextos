---
name: automation-builder-setup
description: "Interactive setup for a tool-agnostic automation builder agent. Run on first boot or when the user says /setup."
---

# Automation Builder Setup

Configure the agent to discover repetitive workflows, map tools, design automations, create safe implementation plans, and hand off coding/workflow work.

## Discovery

```bash
for cmd in gog gh agent-browser jq rg python3 node npm; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'ZAPIER|MAKE|N8N|PIPEDREAM|GOOGLE|NOTION|AIRTABLE|SLACK|DISCORD|GITHUB|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
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

## Completion

Initialize `automations/registry.json`, `automations/specs/`, `automations/runbooks/`, setup review crons, and create the first automation candidate backlog.
