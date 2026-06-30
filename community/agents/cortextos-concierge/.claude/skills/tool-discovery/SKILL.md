---
name: tool-discovery
description: "Safely discover local cortextOS tools, catalog entries, connectors, and configured credentials without exposing secrets."
---

# Tool Discovery

Run this during setup before recommending agents.

## Safe Discovery Commands

```bash
echo "Agent: ${CTX_AGENT_NAME:-unknown} Org: ${CTX_ORG:-unknown} Root: ${CTX_ROOT:-unknown}"
cortextos bus list-agents 2>/dev/null || true
cortextos bus list-skills --format text 2>/dev/null || true
cortextos bus browse-catalog --type agent 2>/dev/null || true
cortextos bus browse-catalog --type skill 2>/dev/null || true
cortextos bus kb-collections --org "$CTX_ORG" 2>/dev/null || true
for cmd in cortextos gh gog jq rg python3 node npm agent-browser; do
  command -v "$cmd" >/dev/null 2>&1 && echo "$cmd=<available>" || echo "$cmd=<missing>"
done
env | grep -E 'GOOGLE|GITHUB|NOTION|AIRTABLE|SLACK|DISCORD|OPENAI|GEMINI|ANTHROPIC|ZAPIER|MAKE|N8N|LINEAR|JIRA|ZENDESK|INTERCOM|OUTLOOK|GMAIL' | sed 's/=.*/=<configured>/'
```

## Rules

- Never print secret values.
- Treat configured environment variables as capability hints, not permission to act.
- If a needed connector or credential is missing, create a `[HUMAN]` task with setup instructions.
- Record results in `concierge/onboarding-profile.json`.
