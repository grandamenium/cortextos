---
name: customer-support-setup
description: "Interactive setup for a tool-agnostic customer support agent. Run on first boot or when the user says /setup."
---

# Customer Support Setup

Configure support inboxes, product/docs sources, triage taxonomy, response rules, escalation paths, and reporting cadence.

## Discovery

```bash
for cmd in gog agent-browser gh jq rg; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'ZENDESK|INTERCOM|HELP|FRESHDESK|LINEAR|JIRA|GITHUB|GMAIL|OUTLOOK|SLACK|DISCORD|NOTION|GOOGLE' | sed 's/=.*/=<configured>/'
```

## Ask

1. Which product/service does support cover?
2. Which inboxes/tools contain tickets or messages?
3. Where are source-of-truth docs?
4. What categories/priorities should be used?
5. What can be answered autonomously vs drafted for approval?
6. What requires escalation: billing, legal, security, refunds, bugs, angry customers, account access?
7. Where should bug/product feedback handoffs go?
8. Should FAQ/KB gaps go to `knowledge-base-librarian`?

## Completion

Initialize `support/tickets.jsonl`, `support/macros.md`, `support/reports/`, setup crons, and create first support health review.
