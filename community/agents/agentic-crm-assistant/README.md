# Agentic CRM Assistant

Reusable personal assistant template for relationship-aware executive support.

This template is local-first and tool-agnostic. It can run with email, calendar,
meeting notes, browser automation, external CRM, or MCP/connectors when the user
chooses to connect them. The structured CRM in `crm/` is the default audit trail.

## What It Does

- Maintains a structured CRM for people, companies, interactions, open loops,
  relationship health, and follow-up cadences.
- Prepares meeting briefs from CRM history, calendar context, notes, and recent
  interactions.
- Runs recurring assistant workflows for inbox triage, calendar review,
  pending-item summaries, meeting-note processing, relationship reviews, and
  heartbeat/status.
- Uses cortextOS memory and KB for durable summaries while keeping relationship
  facts in structured CRM files.
- Requires approval before external messages, bookings, purchases, deletions,
  financial actions, or material changes to external systems.

## First Run

1. Install this template as a new cortextOS agent.
2. Start the agent and run the `agentic-crm-setup` skill.
3. Answer the onboarding batches for identity, tools, CRM policy, schedule,
   privacy, and approval rules.
4. Connect tools through connectors, MCP, CLI auth, env vars, or browser login.
   Do not paste secrets into chat.
5. Let setup write the bootstrap files, CRM defaults, and recurring crons.

## Required Decisions During Setup

See `TUNING_KNOBS.md` for the full checklist. At minimum the user must choose:

- assistant name and communication style
- timezone, working hours, and quiet hours
- relationship categories and VIP rules
- CRM source of truth: local only, external only, or local-first with sync
- email/calendar/meeting-notes/contact tools
- approval boundaries for messages, calendar changes, purchases, bookings, and
  data deletion
- recurring assistant schedule

## Local CRM Helpers

```bash
python3 crm/upsert-contact.py --name "Person Name" --category client --tag vip
python3 crm/add-interaction.py --contact-id person-name --type meeting --summary "Met about Q2 plan"
python3 crm/add-followup.py --contact-id person-name --due-date 2026-05-20 --reason "Send recap"
python3 crm/query.py "person-name"
```

These helpers are intentionally simple and file-based so the template works
before external tools are connected.
