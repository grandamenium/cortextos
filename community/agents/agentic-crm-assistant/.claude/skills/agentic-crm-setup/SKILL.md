---
name: agentic-crm-setup
description: "Full interactive setup for the agentic CRM personal assistant template. Use at first boot or whenever the user asks to configure/reconfigure the assistant."
---

# Agentic CRM Setup Skill

This skill turns the generic template into a user's assistant. It is intentionally a full onboarding, not a quick questionnaire.

## Setup Principles

- Ask questions in small batches. If the user is on Telegram, stop after each batch and wait for their reply.
- Keep all user-specific information out of community template files until the user provides it.
- Use tool discovery before asking the user to type credentials.
- Never ask for secrets in chat. Ask the user to place credentials in agent `.env`, org `secrets.env`, connector configuration, or the relevant tool's auth flow.
- Write every answer to the correct bootstrap or CRM file.

## Tuning Knobs to Collect

### Identity

- assistant name
- user preferred name
- user's role/context
- assistant tone
- message length and update style
- day/night hours
- timezone

### Scope

- "personal assistant" scope: inbox, calendar, meetings, personal commitments, travel, errands, finance reminders, family/personal admin
- CRM scope: personal contacts, family/friends, professional network, customers/clients, investors, partners, creators/community, vendors, referrals
- excluded domains: anything the assistant should never touch

### Privacy

- local CRM only vs external CRM sync
- what may be stored in memory
- what may be ingested into KB
- redaction requirements for outputs
- data retention preferences

### Approval Rules

- external email/message send
- calendar event creation/update/delete
- purchases/bookings/cancellations
- data deletion
- financial actions
- exception contacts or domains

### Tools

- email provider(s)
- calendar provider(s)
- meeting notes/transcript provider(s)
- contact source(s)
- external CRM, if any
- browser automation availability
- local CLI/MCP/connectors

### Schedule and Crons

- inbox triage cadence
- morning calendar review time
- evening calendar review time
- pending-items digest time
- relationship review cadence
- meeting notes processing cadence
- quiet hours and emergency criteria

### CRM Schema

- contact categories
- relationship strength scale
- health/staleness rules
- VIP list
- follow-up cadence by category
- interaction types
- required fields
- custom tags

## Tool Discovery

Run discovery commands and write results to `TOOLS.md`.

```bash
command -v gog >/dev/null && gog --version || true
command -v gh >/dev/null && gh --version | head -1 || true
command -v agent-browser >/dev/null && agent-browser --version || true
ls .mcp.json 2>/dev/null || true
env | grep -E 'GMAIL|GOOGLE|OUTLOOK|NOTION|CRM|HUBSPOT|PIPEDRIVE|AIRTABLE|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
```

If no email/calendar/notes tools are found, create a human task:

```bash
cortextos bus create-task "[HUMAN] Configure assistant tools" --desc "Connect email, calendar, meeting notes, and optional CRM for $CTX_AGENT_NAME. Do not paste secrets in chat; use connector setup, .env, org secrets.env, or provider CLI auth."
```

## File Writes

After gathering answers, update:

- `IDENTITY.md` — assistant name, role, vibe, work style
- `USER.md` — all user-specific preferences and tuning knobs
- `SOUL.md` — approval rules, autonomy, day/night mode, communication
- `GOALS.md` and `goals.json` — initial operational goals
- `SYSTEM.md` — org, timezone, orchestrator, communication style
- `TOOLS.md` — detected and configured commands
- `config.json` — timezone, day mode, cron cadence
- `crm/contacts.json` — seed contacts and categories
- `crm/relationship-health.json` — review cadence defaults
- `crm/followups.jsonl` — initial commitments if supplied
- `MEMORY.md` — durable preferences only

## Suggested Question Batches

### Batch 1: Identity and Scope

Ask:

1. What should I be called?
2. What should I call you?
3. What kind of personal assistant should I be for you?
4. Which domains should I manage: inbox, calendar, meetings, CRM, personal reminders, travel, errands, finances, other?
5. What should I never touch?

### Batch 2: Tools

Ask:

1. Which email/calendar/meeting notes/contact/CRM tools do you use?
2. Are they already connected through MCP, connectors, CLIs, browser login, or env vars?
3. Should I use local structured CRM files as the source of truth, an external CRM, or local-first with sync?

### Batch 3: CRM

Ask:

1. What relationship categories do you want?
2. Who are the first VIPs I must never miss?
3. What counts as a relationship going stale?
4. What interaction types matter?
5. What tags or custom fields matter in your life/business?

### Batch 4: Schedule

Ask:

1. Working hours and quiet hours?
2. Protected time blocks?
3. Preferred meeting windows and buffer rules?
4. When should I send morning/evening/pending-items summaries?
5. How often should I do relationship reviews?

### Batch 5: Approval Rules

Ask:

1. What may I do autonomously?
2. What always requires approval?
3. Are there contacts/domains I may message without approval?
4. Should I create drafts automatically?
5. Should I create calendar holds autonomously or only propose them?

## Completion

When setup is complete:

```bash
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus update-heartbeat "setup complete; CRM assistant online"
cortextos bus log-event action onboarding_completed info --meta '{"agent":"'$CTX_AGENT_NAME'","template":"agentic-crm-assistant"}'
```

Send the user a concise summary:

- configured scope
- connected tools
- CRM source of truth
- cron schedule
- approval boundaries
- first three actions you will take
