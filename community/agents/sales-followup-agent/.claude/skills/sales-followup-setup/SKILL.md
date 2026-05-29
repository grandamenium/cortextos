---
name: sales-followup-setup
description: "Interactive setup for a tool-agnostic sales and lead follow-up agent. Run on first boot or when the user says /setup."
---

# Sales Follow-Up Setup

Configure pipeline stages, lead sources, CRM source of truth, outreach rules, approvals, and follow-up cadences.

## Discovery

```bash
for cmd in gog agent-browser gh jq rg; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'HUBSPOT|PIPEDRIVE|SALESFORCE|AIRTABLE|NOTION|GOOGLE|GMAIL|OUTLOOK|APOLLO|CLAY|SMARTLEAD|INSTANTLY' | sed 's/=.*/=<configured>/'
```

## Ask

1. What is being sold and to whom?
2. What are the stages: lead, qualified, call booked, proposal, negotiation, closed, lost?
3. Where do leads come from?
4. What CRM/tool is source of truth: local files, HubSpot, Pipedrive, Salesforce, Airtable, Notion, Sheets, other?
5. What follow-up cadence should be used per stage?
6. What messaging channels are allowed?
7. What must always be approved before sending?
8. What claims, guarantees, discounts, or promises are forbidden?
9. Which agents should receive handoffs: research for lead intel, KB for sales docs, support for customer issues, project manager for delivery handoff?

## Completion

Initialize `sales/pipeline.json`, `sales/interactions.jsonl`, `sales/followups.jsonl`, setup crons, and create first pipeline hygiene report.
