# Customer Support Agent

Template for local-first support triage, reply drafting, escalation, and support knowledge improvement.

Run `/setup` to configure inboxes, docs, categories, escalation rules, and approval boundaries.

## Local First

The template works without external tools using:

- `support/tickets.jsonl` for incoming tickets.
- `support/macros.md` for approved response patterns.
- `support/escalation-policy.json` for risk routing.
- `support/drafts/` for approval-ready customer replies.
- `support/kb-gaps/` for missing docs, weak macros, and product feedback.
- `support/reports/` for triage and review reports.

Optional connectors can be added later for Zendesk, Intercom, Freshdesk, Help Scout, Gmail, Outlook, GitHub, Linear, or Jira. Customer sends remain approval-gated.
