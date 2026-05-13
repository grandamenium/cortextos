---
name: tool-discovery
description: "Discover available email, calendar, contacts, meeting notes, browser, and CRM tools for a tool-agnostic personal assistant."
---

# Tool Discovery Skill

Use during setup and whenever a workflow fails because a tool may be missing.

## Discover Local CLIs

```bash
for cmd in gog gh agent-browser peekaboo sqlite3 jq rg; do
  if command -v "$cmd" >/dev/null; then
    echo "$cmd: $(command -v "$cmd")"
  fi
done
```

## Discover MCP/Connector Hints

```bash
test -f .mcp.json && cat .mcp.json
env | grep -E 'GMAIL|GOOGLE|OUTLOOK|NOTION|ZOOM|FATHOM|HUBSPOT|PIPEDRIVE|AIRTABLE|CRM' | sed 's/=.*/=<configured>/'
```

## Record Results

Append a `## Configured Tools` section to `TOOLS.md` with:

- provider
- command or connector name
- account identifier, if safe
- read/write capability
- approval requirement
- fallback path

Never write secrets to `TOOLS.md`.
