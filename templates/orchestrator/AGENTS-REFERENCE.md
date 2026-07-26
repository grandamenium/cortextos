# AGENTS Reference

Low-frequency reference extracted from `AGENTS.md`.

Open this file only when the active task needs one of the sections below.

## §session-end-template

```bash
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Session End - $(date -u +%H:%M:%S UTC)
- Status: [done/interrupted/context-full]
- Current state: [where things stand - specific enough that the next session can resume cold]
- Active threads: [anything in progress or mid-task with current state]
- Key decisions: [significant decisions from this session worth carrying forward]
- For next session: [what to do first and what context is needed]

MEMEOF
```

## §context-handoff-config

**Configuration knobs (config.json):**
- `ctx_warning_threshold` - default 30.
- `ctx_handoff_threshold` - default 60.

## §time-commands

**Always use local time** when communicating with users or scheduling work:

```bash
# Current local time
date                          # uses TZ env var automatically

# Format for display
date +'%A %B %-d at %-I:%M %p'   # e.g. "Monday April 6 at 9:30 AM"

# ISO with timezone
date --iso-8601=seconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
```

**Check your timezone:**
```bash
echo "My timezone: $CTX_TIMEZONE"
date +'Current time: %A %B %-d %Y at %-I:%M %p %Z'
```

If `CTX_TIMEZONE` is empty, check `config.json` or ask the user to set it:
```bash
# User sets timezone - update config.json and tell them to restart
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Your timezone is not configured. What timezone are you in? (e.g. America/New_York, Europe/London, Asia/Tokyo)"
```

## §blocked-human-approval-commands

### BLOCKED

```bash
# Block your task
cortextos bus update-task <task_id> blocked
# Log the blocker so it's visible in the activity feed
cortextos bus log-event task task_blocked info --meta '{"task_id":"<task_id>","blocked_by":"<blocker_task_id>","reason":"<what>"}'
```

When the blocker completes, you will receive an inbox message automatically. Unblock immediately:

```bash
cortextos bus update-task <task_id> in_progress
```

### HUMAN TASK

```bash
# Create the human task with clear step-by-step instructions
cortextos bus create-task "[HUMAN] <what needs to be done>" --desc "<instructions>" --project human-tasks

# Block your own task pointing to it
cortextos bus update-task <your_task_id> blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"<your_task_id>","blocked_by":"<human_task_id>","reason":"human dependency"}'

# Notify orchestrator so it surfaces in briefing
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Human task created: [HUMAN] <title> - needed before I can proceed with <your task>"
```

### APPROVAL

```bash
# Create approval and capture the ID
APPR_ID=$(cortextos bus create-approval "<what you want to do>" "<category>" "<context and draft>")

# Notify user immediately
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Approval needed: <title> - check dashboard"

# Block your task
cortextos bus update-task <task_id> blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"<task_id>","blocked_by":"'$APPR_ID'","reason":"awaiting approval"}'
```

## §memory-templates

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMEOF

## Session Start - $(date -u +%H:%M:%S UTC)
- Status: online
- Crons active: <list from `cortextos bus list-crons $CTX_AGENT_NAME`>
- Inbox: <N messages or "empty">
- Current state: <where things stand - what is in progress, pending, or needs attention>
- Resuming: <what to do next and why, with enough context to act without re-reading everything>

MEMEOF
```

Entry formats:
```bash
## Heartbeat - HH:MM UTC
- Current focus: <what I am working on and why>
- Active threads: <anything in progress or being monitored - state of each>
- Key decisions: <decisions made since last entry with brief rationale>
- Context notes: <anything non-obvious - user preferences discovered, environment state, blockers>
- Next: <what I am doing next>
```

## §knowledge-base-layer-3

### Layer 3: Knowledge Base - Associative Memory (RAG/ChromaDB)

The knowledge base is a semantic vector store (ChromaDB, Gemini Embedding 2). Think of it as your associative memory - not held in your head, but instantly searchable by meaning. It works like your own memory system: Gemini describes every non-text file (image, video, audio, PDF, Office doc) and embeds the description together with the content so you can find things by what they mean, not just what they literally say. Queries return the matching content plus full metadata: source path, similarity score, file type, chunk position, page number, timestamps.

**Three collections - different management models:**

| Collection | Scope | What goes in | How managed |
|---|---|---|---|
| `memory-{agent}` | Private | MEMORY.md + daily memory files | **Auto** - re-indexed on every heartbeat |
| `private-{agent}` | Private | Your outputs, research docs, workspace files | **Agent-managed** - ingest when you produce something worth keeping |
| `shared-{org}` | Org-wide | Research findings, reports, org knowledge | **Agent-managed** - ingest when the whole org benefits |

**memory-{agent} is automatic.** On every heartbeat cycle, re-ingest your memory files so they stay current and searchable:
```bash
# Run on every heartbeat
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

**When to query - before starting any task:**
- Before starting any task - what context exists on this topic?
- When the user asks a factual question about the org, projects, or people
- When you encounter an error - has this happened before?
- When referencing named entities (clients, projects, systems)
- To recall your own past work: query `memory-{agent}` or `private-{agent}` specifically

**When to ingest private-{agent} and shared-{org} - your judgment:**
- After completing a task with a notable output -> `private-{agent}`
- After completing research -> `shared-{org}` (the whole org benefits)
- After producing a document, report, or significant file -> appropriate scope
- After the user shares a file with you -> `private-{agent}`
- After a workflow completes -> ingest the artifacts

```bash
# Query before any task (searches all your collections by default)
cortextos bus kb-query "your question" --org $CTX_ORG --agent $CTX_AGENT_NAME

# Query only your memory (past experiences, patterns)
cortextos bus kb-query "question" --org $CTX_ORG --collection memory-$CTX_AGENT_NAME

# Ingest output to your private collection
cortextos bus kb-ingest /path/to/output --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private

# Ingest research to org shared collection
cortextos bus kb-ingest /path/to/research --org $CTX_ORG --scope shared

# List collections (verify KB is ready)
cortextos bus kb-collections --org $CTX_ORG
```

**Requires:** `GEMINI_API_KEY` in `orgs/$CTX_ORG/secrets.env`

CONSEQUENCE: Without querying, you repeat work the org already did. Without ingesting, the org permanently loses institutional memory.
TARGET: Query before every task. Ingest every significant output. Memory collection updates itself at heartbeat.

## §event-logging-table

```bash
cortextos bus log-event <category> <event> <severity> --meta '<json>'
```

**Log these events every time they happen:**

| When | Category | Event | Severity |
|------|----------|-------|----------|
| Session starts | action | session_start | info |
| Session ends | action | session_end | info |
| Task created | task | task_created | info |
| Task completed | task | task_completed | info |
| Task blocked | task | task_blocked | info |
| Approval created | action | approval_created | info |
| Approval resolved | action | approval_resolved | info |
| Cron fired and completed | action | cron_completed | info |
| Workflow run completed | action | workflow_completed | info |
| Significant output created | action | output_created | info |
| Research completed and ingested to KB | action | research_completed | info |
| Error or failure | error | <error_type> | error |
| Significant decision made | action | decision_made | info |

## §external-persistent-crons

## External Persistent Crons

### The Model

Persistent crons live in `${CTX_ROOT}/state/${CTX_AGENT_NAME}/crons.json`. The daemon owns this file - it reads it on every agent start, schedules each entry, and fires them by injecting prompts directly into your PTY session. Retry logic: 1s, 4s, 16s on injection failure. Execution is logged to `${CTX_ROOT}/state/${CTX_AGENT_NAME}/cron-execution.log`.

Key properties:

- **Survives daemon restarts.** State is on disk, not in memory.
- **Survives agent restarts.** The daemon re-reads `crons.json` and re-schedules on every agent boot.
- **Not session-local.** A cron defined here fires whether or not the session that created it is still running.

### /loop vs Persistent Crons

`/loop` is Claude Code's built-in for ephemeral polling inside a single session. Use it when you need something to repeat for the duration of one conversation (e.g., "check agent status every 2 minutes for 10 minutes"). It dies when the session ends.

For ANY work that should survive restarts - morning/evening reviews, fleet monitoring, approval sweeps, weekly reviews - use `cortextos bus add-cron`.

| Need | Use |
|------|-----|
| Repeat for this session only | `/loop <interval> <prompt>` |
| Persist across restarts | `cortextos bus add-cron` |
| One-time future fire | `cortextos bus add-cron --schedule <ISO>` |

### Migration from config.json

Automatic. On agent boot, the daemon migrates `config.json` crons to `crons.json` once. A marker file `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.crons-migrated` prevents re-runs. The source `config.json` is left untouched - non-destructive.

You do not need to do anything. If you want to verify: check that `.crons-migrated` exists and `crons.json` is populated.

### Examples

**1. Heartbeat every 6 hours:**
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h Read HEARTBEAT.md and follow its instructions.
```

**2. Morning review at 9am on weekdays (cron expression):**
```bash
cortextos bus add-cron $CTX_AGENT_NAME morning-review "0 9 * * 1-5" Read .claude/skills/morning-review/SKILL.md and run the morning review.
```

**3. Fleet monitor every 4 hours, offset to avoid stampede:**
```bash
cortextos bus add-cron $CTX_AGENT_NAME fleet-monitor "15 */4 * * *" Read HEARTBEAT.md and check all agent heartbeats. Flag any stale agents.
```

**4. Test that a cron fires correctly:**
```bash
cortextos bus test-cron-fire $CTX_AGENT_NAME heartbeat
```
This injects the cron prompt immediately - use it to confirm the wiring is correct before waiting for the first scheduled fire.

### How to Verify

```bash
# List all scheduled crons for this agent (shows next_fire_at for each)
cortextos bus list-crons $CTX_AGENT_NAME

# View execution history
cortextos bus get-cron-log $CTX_AGENT_NAME

# Confirm migration ran
ls "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.crons-migrated"

# Inspect crons.json directly
cat "${CTX_ROOT}/state/${CTX_AGENT_NAME}/crons.json"
```

For full CRUD (update, pause, resume, delete), see `.claude/skills/cron-management/SKILL.md`.
