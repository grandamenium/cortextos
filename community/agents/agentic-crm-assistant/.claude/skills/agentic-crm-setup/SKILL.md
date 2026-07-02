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

## Tool Discovery + Connect (do NOT hand-wave this)

This is the make-or-break step. Detecting a tool is not connecting it. For every
domain the user names a service for, run the full **`tool-discovery` connect loop**:
prefer a CLI, research that CLI live if you do not already know it, walk the user
through install + auth in the conversation, and **verify with a real read** before
moving on. See `tool-discovery/SKILL.md` for the loop; the short version:

1. Detect what is already installed and authed.
2. Per domain (email, calendar, contacts, meeting notes, messaging/iMessage,
   external CRM): ask what service they use.
3. Prefer CLI > connector/MCP > browser. If you do not know the CLI for the named
   service, research it (WebSearch/WebFetch its install + auth docs, or read
   `<cli> --help`) before instructing the user.
4. Walk them through it on the fly — exact install command, then the exact auth
   command they run themselves (e.g. `! gog login you@example.com`). Secrets never
   go in chat.
5. Verify with a real action (`gog auth status` + list today's calendar; list the
   latest meeting note; a bounded iMessage read) and report the result in Telegram.
6. Record each connected tool in `TOOLS.md` with how it was verified. Loop.

Only create a `[HUMAN]` task if the user cannot complete an auth step right now
(e.g. needs an admin, a paid plan, or credentials they do not have). Make it
specific — the exact tool, the exact command, and where the credential goes — not
a generic "connect your tools":

```bash
cortextos bus create-task "[HUMAN] Finish <tool> auth for $CTX_AGENT_NAME" --desc "Run: <exact command>. Credential goes in <exact location>. Do not paste secrets in chat. Blocking: <which workflow this unblocks>."
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

Ask which service they use per domain, then run the Tool Discovery + Connect loop
above for each one (research the CLI, walk them through auth, verify):

1. Email + calendar — which provider (Gmail/Google, Outlook, other)?
2. Meeting notes — Granola, Fathom, Fireflies, Zoom, other, none?
3. Messaging — do you want me to read/handle iMessage or another messenger?
4. Contacts — Google Contacts, phone export, an external CRM, none?
5. External CRM — HubSpot/Pipedrive/Airtable/Notion/etc, or local files as source of truth?

Tell them up front: for each one they name, I will find the right CLI, walk you
through connecting it right here, and confirm it works before moving on. No secrets
in chat.

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
