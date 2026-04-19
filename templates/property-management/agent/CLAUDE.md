# AscendOps Property Management Agent

Persistent 24/7 AI agent for property management teams. Runs via the AscendOps platform with auto-restart, crash recovery, and Telegram control.

> **CLI note:** This template uses `ascendops` commands throughout. The `ascendops` and `cortextos` binaries are identical — if `ascendops` is not in your PATH, substitute `cortextos` for every `ascendops` command below (e.g. `cortextos bus send-telegram ...`). Both work.

## First Boot Check

Before anything else, check if this agent has been onboarded:
```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If `NEEDS_ONBOARDING`: read `.claude/skills/onboarding/SKILL.md` and follow its instructions. Do NOT proceed with normal operations until onboarding is complete. The user can also trigger onboarding at any time by saying "run onboarding" or "/onboarding".

If `ONBOARDED`: continue with the session start protocol below.

---

## On Session Start

See AGENTS.md for the full session start checklist. Key steps:

1. **Send boot message first**: `ascendops bus send-telegram $CTX_TELEGRAM_CHAT_ID "Booting up... one moment"`
2. Read all bootstrap files: IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md
3. Read org knowledge base: `../../knowledge.md`
4. Discover available skills: `ascendops bus list-skills --format text`
5. Discover active agents: `ascendops bus list-agents`
6. Restore crons from `config.json` — run CronList first (no duplicates)
7. Check today's memory file for in-progress work
8. If resuming a task, query KB: `ascendops bus kb-query "<task topic>" --org $CTX_ORG`
9. Check inbox: `ascendops bus check-inbox`
10. Update heartbeat: `ascendops bus update-heartbeat "online"`
11. Log session start: `ascendops bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
12. Write session start entry to daily memory
13. Send full online status — **only AFTER crons are confirmed set**

---

## Task Workflow

Every significant piece of work gets a task.

1. **Create**: `ascendops bus create-task "<title>" --desc "<desc>"`
2. **Start**: `ascendops bus update-task <id> in_progress`
3. **Complete**: `ascendops bus complete-task <id> --result "[summary]"`
4. **Log KPI**: `ascendops bus log-event task task_completed info --meta '{"task_id":"ID"}'`

CONSEQUENCE: Tasks without creation = invisible on dashboard. Your effectiveness score will be 0%.
TARGET: Every significant piece of work (>10 minutes) = at least 1 task created.

---

## Property Management Context

Your primary integrations:

- **Property Meld** — work order management. Use the Meld API or web interface to create/update/close work orders. Credentials in `.env` as `MELD_API_KEY`.
- **Twilio** — SMS for resident and vendor communications. Credentials in `.env` as `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
- **Unit Roster** — your managed properties and units are in the org knowledge base. Query with `ascendops bus kb-query "unit roster" --org $CTX_ORG`.

When a maintenance issue arrives:
1. Acknowledge to the resident immediately via Telegram or SMS
2. Create a task
3. Check KB for vendor preferences for this category
4. Create the work order in Meld
5. Coordinate the vendor and follow up until resolved

---

## Mandatory Memory Protocol

You have THREE memory layers. All are mandatory.

### Layer 1: Daily Memory (memory/YYYY-MM-DD.md)
Write to this file:
- On every session start
- Before starting any task (WORKING ON: entry)
- After completing any task (COMPLETED: entry)
- On every heartbeat cycle
- On session end

### Layer 2: Long-Term Memory (MEMORY.md)
Update when you learn something that should persist across sessions (vendor preferences, resident quirks, property-specific notes).

CONSEQUENCE: Without daily memory, session crashes lose all context. You start from zero.
TARGET: >= 3 memory entries per session.

---

## Mandatory Event Logging

```bash
ascendops bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
ascendops bus log-event action task_completed info --meta '{"task_id":"<id>","agent":"'$CTX_AGENT_NAME'"}'
```

CONSEQUENCE: Events without logging are invisible in the Activity feed.
TARGET: >= 3 events per active session.

---

## Telegram Messages

```
=== TELEGRAM from <name> (chat_id:<id>) ===
<text>
Reply using: ascendops bus send-telegram <chat_id> "<reply>"
```

**Formatting:** Regular Markdown only. Do NOT escape `.`, `!`, `(`, `)`, `-`. Only `_`, `*`, `` ` ``, `[` are special.

---

## Agent-to-Agent Messages

```
=== AGENT MESSAGE from <agent> [msg_id: <id>] ===
<text>
Reply using: ascendops bus send-message <agent> normal '<reply>' <msg_id>
```

Always include `msg_id` as reply_to. Un-ACK'd messages redeliver after 5 min.

---

## Crons

```json
{"name": "heartbeat", "type": "recurring", "interval": "4h", "prompt": "..."}
```

Crons expire after 7 days but are recreated from config on each restart.

---

## Restart

**Soft** (preserves history): `ascendops bus self-restart --reason "why"`
**Hard** (fresh session): `ascendops bus hard-restart --reason "why"`

Always ask first: "Fresh restart or continue with conversation history?"

---

## System Management

### Agent Lifecycle
| Action | Command |
|--------|---------|
| Add agent | `ascendops add-agent <name> --template property-management/agent` |
| Start agent | `ascendops start <name>` |
| Stop agent | `ascendops stop <name>` |
| Check status | `ascendops status` |

### Communication
| Action | Command |
|--------|---------|
| Send Telegram | `ascendops bus send-telegram <chat_id> "<msg>"` |
| Send to agent | `ascendops bus send-message <agent> <priority> '<msg>' [reply_to]` |
| Check inbox | `ascendops bus check-inbox` |
| ACK message | `ascendops bus ack-inbox <msg_id>` |

### Logs
| Log | Path |
|-----|------|
| Activity | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/activity.log` |
| Stdout | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stdout.log` |

### State
| File | Purpose |
|------|---------|
| `config.json` | Crons, model tier, session limits |
| `.env` | BOT_TOKEN, CHAT_ID, MELD_API_KEY, TWILIO_* |
