---
name: ticket-triage
description: "Triage support tickets/messages, draft replies, escalate issues, and update support knowledge gaps."
---

# Ticket Triage

Use this for local-file triage, configured connector triage, or manual ticket review. The safe default is local files only.

## Inputs

- Local queue: `support/tickets.jsonl`.
- Config: `support/config.json`.
- Macros: `support/macros.md`.
- Escalation policy: `support/escalation-policy.json`.
- Optional docs: configured local docs, KB collections, website exports, or documentation folders.
- Optional connectors if configured: Zendesk, Intercom, Freshdesk, Help Scout, Gmail, Outlook, GitHub, Linear, Jira.

## Workflow

1. Create or update a visible task for the triage run and mark it `in_progress`.
2. Read the next unprocessed local ticket from `support/tickets.jsonl` or pull from a configured connector/export.
3. Validate ticket shape against `support/schemas/ticket.schema.json` where feasible.
4. Classify by source, requester, product area, category, priority, sentiment, SLA risk, and escalation flags.
5. Search `support/config.json`, `support/macros.md`, `support/escalation-policy.json`, local docs, and configured KB collections before drafting.
6. Draft a reply with citations or internal source links. Write it to `support/drafts/<ticket-id>.md`.
7. If the reply should be sent to a customer or an external ticket should be mutated, create an approval and block the task until approved. Do not send without approval.
8. Escalate bugs, billing/refund, security, legal, privacy, angry customers, VIP customers, account access, incidents, or policy exceptions by creating an escalation task and recording the blocker.
9. Write `support/kb-gaps/<ticket-id>.json` if docs/macros were missing, unclear, repeated, or product feedback surfaced.
10. Write or update `support/reports/<date>-triage-report.md` with tickets processed, drafts, approvals, escalations, KB gaps, and next actions.
11. Update memory with durable lessons, omitting unnecessary PII.
12. Complete or block the triage task with a precise result.

## Approval Gate

Always create an approval before:

- Sending an email, chat response, or ticket reply to a customer.
- Posting a public comment.
- Changing external ticket status, priority, assignee, tags, or SLA fields.
- Issuing refunds, credits, or billing changes.
- Changing account access, deleting data, or disclosing sensitive data.
- Making policy exceptions or commitments not present in approved docs.

## Local Smoke Path

```bash
mkdir -p support/drafts support/reports support/kb-gaps
test -f support/tickets.jsonl || cp support/examples/tickets.example.jsonl support/tickets.jsonl
head -n 1 support/tickets.jsonl
rg -n "login|password|billing|refund|bug|outage|security" support/macros.md support/escalation-policy.json support/config.json
```

Then draft `support/drafts/example-ticket-001.md`, write any gap to `support/kb-gaps/example-ticket-001.json`, and write the run report to `support/reports/<date>-triage-report.md`.
