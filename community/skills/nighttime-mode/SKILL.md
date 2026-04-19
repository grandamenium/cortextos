---
name: nighttime-mode
description: "Autonomous overnight orchestration mode. Active outside day hours. Dispatch and monitor deep work across agents while user sleeps. Internal building only — no external actions."
triggers: ["nighttime mode", "overnight mode", "night mode", "overnight orchestration", "nighttime protocol", "tool mastery", "overnight tool study"]
external_calls: []
---

# Nighttime Mode

> Orchestrate deep work across agents while the user sleeps.
> Dispatch tasks, monitor progress, prepare morning briefing.

---

## Hard Guardrails — NEVER Cross

1. **No external communications** — No emails, messages, posts, or DMs sent to anyone outside the system
2. **No purchases or transactions** — No buying, no transfers, no commitments
3. **No permanent deletes** — All actions must be reversible
4. **No production deploys** — Prepare PRs, don't merge; build assets, don't publish
5. **No commitments on user's behalf** — No promises, deadlines, or agreements
6. **No approval creation at night** — Queue approval requests for morning; do not create them at night

**When in doubt:** Document it, present in morning review.

---

## What TO Do Overnight

| Category | Examples | Assign to |
|----------|----------|-----------|
| Research | Market analysis, competitor research, trend analysis | research agents |
| Building | Code on feature branches, scripts, tools | dev agents |
| Content drafts | Scripts, outlines, social copy (drafts only) | content agents |
| Analysis | Data processing, metrics review, document processing | analyst agents |
| Organization | File organization, task grooming, template creation | any appropriate agent |
| Self-improvement | Skill development, workflow optimization | orchestrator |
| Tool mastery | API doc study, read-only endpoint tests, KB ingestion of findings | each agent (assigned tools) |

---

## Tool Mastery Block (Standing Overnight Activity)

Each agent has an assigned tool set listed in their IDENTITY.md. During nighttime quiet periods
(no active dispatch work), agents run a tool mastery block — one assigned tool per night.

### Protocol (per agent, per tool)

1. **Read** — Study the tool's API docs, SDK reference, or TOOLS.md entry for 20-30 min
2. **Test** — Run 2-3 read-only calls to verify auth, response shape, and rate limits
3. **Document** — Write a findings file with: working endpoints, gotchas, rate limits, error codes, useful examples
4. **Ingest** — Run `cortextos bus kb-ingest <path-to-findings.md> --org $CTX_ORG`
5. **Log** — Append a one-paragraph summary to today's memory file

### Dispatch (orchestrator sends this to each agent)

```bash
cortextos bus send-message <agent> normal 'Tool mastery block: study and test <tool-name> tonight.
1. Read the API docs / TOOLS.md entry
2. Run 2-3 read-only calls and note response shapes, rate limits, and gotchas
3. Write findings to /tmp/tool-mastery-<tool>-$(date +%Y%m%d).md
4. cortextos bus kb-ingest /tmp/tool-mastery-<tool>-$(date +%Y%m%d).md --org '$CTX_ORG'
5. Append a one-line summary to memory/$(date +%Y-%m-%d).md and report back'
```

### Example (blue running tool mastery on PM Nexus API)

```bash
# Test a read-only endpoint
curl -s -H "Authorization: Bearer $MELD_API_KEY" \
  "https://api.propertymeld.com/api/v3/meld/?limit=5" | jq '.count, .results[0].id'

# Write findings
cat > /tmp/tool-mastery-nexus-$(date +%Y%m%d).md << 'EOF'
# PM Nexus API — Tool Mastery Notes

## Auth
Bearer token via MELD_API_KEY env var.

## Working endpoints tested
- GET /api/v3/meld/ — list melds, paginated, 100/page max
- GET /api/v3/meld/{id}/ — single meld detail
- GET /api/v3/vendor/ — vendor list (id, name, specialty)

## Read-only confirmed
inhouseservicerids assignment requires Playwright (API returns 403 on PATCH)

## Gotchas
- Status filter: ?status=new,in-progress (comma-separated, no spaces)
- Date filter: ?date_created_after=2026-04-01T00:00:00Z (ISO 8601 with Z required)
EOF

# Ingest
cortextos bus kb-ingest /tmp/tool-mastery-nexus-$(date +%Y%m%d).md --org ascendops

# Log to memory
echo "Tool mastery: PM Nexus API — tested 3 endpoints, ingested findings. Key: PATCH blocked, use Playwright for assignment." >> memory/$(date +%Y-%m-%d).md

# Report back to orchestrator
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" normal "Tool mastery complete: PM Nexus API. 3 endpoints tested, findings ingested to KB."
```

### Assigned Tool Sets

See each agent's IDENTITY.md for their assigned tools. Summary:

- **blue**: PM Nexus API, Property Meld Playwright, Twilio SMS, vendor DB (knowledge.md)
- **collie**: cortextos bus CLI, gh CLI, upstream PR workflow, agentskills.io catalog

---

## Quick Start Loop

```
1. CHECK: cortextos bus list-tasks --status in_progress
   → Any overnight tasks dispatched?

2. IF tasks are running:
   a. Check agent heartbeats: cortextos bus read-all-heartbeats
   b. Check inbox for completion reports: cortextos bus check-inbox
   c. Process completions, dispatch next tasks if queue has more
   d. GOTO step 1

3. IF no tasks pending:
   a. Dispatch tool mastery block to each agent (see above)
   b. Begin preparing morning briefing data
   c. Update heartbeat: cortextos bus update-heartbeat "preparing morning briefing"
```

---

## Overnight Orchestration Protocol

### Step 1: Check approved queue

```bash
cortextos bus list-tasks --status in_progress
cortextos bus read-all-heartbeats
```

### Step 2: Monitor agent progress

```bash
# Check heartbeats regularly (every ~1h)
cortextos bus read-all-heartbeats

# Check inbox for completion reports
cortextos bus check-inbox
```

### Step 3: Process completions

When an agent reports task completion:

```bash
# 1. Complete the task in cortextOS
cortextos bus complete-task "$TASK_ID" --result "<what was produced>"

# 2. Log the event
cortextos bus log-event task task_completed info --meta '{"task_id":"'$TASK_ID'","agent":"<completing_agent>"}'

# 3. Write to memory
TODAY=$(date -u +%Y-%m-%d)
echo "COMPLETED: $TASK_ID - <description> (by <agent>)" >> "memory/$TODAY.md"

# 4. Dispatch next task if queue has more
cortextos bus list-tasks --status pending
```

### Step 4: Handle blockers

When an agent reports a blocker:

```bash
# 1. Log the blocker
TODAY=$(date -u +%Y-%m-%d)
echo "BLOCKED: $TASK_ID - <reason> (agent: <name>)" >> "memory/$TODAY.md"

# 2. Try to unblock if possible (provide info, reassign)
cortextos bus send-message <agent> normal '<unblocking info or reassignment>'

# 3. If cannot unblock, queue for morning review
echo "MORNING REVIEW NEEDED: Blocker - $TASK_ID - <reason>" >> "memory/$TODAY.md"
```

---

## Heartbeat During Nighttime

Update regularly to show overnight activity:

```bash
cortextos bus update-heartbeat "nighttime mode - X/Y tasks complete, monitoring agents"
```

---

## Before Morning: Prepare Briefing Data

Before the morning review cron fires, ensure this data is ready in today's memory:

1. What was completed (by which agent, key deliverables with file paths)
2. What needs user review or decision
3. Blockers discovered that need morning attention
4. Recommended priorities for today

```bash
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Overnight Summary - $(date -u +%H:%M:%S)

### Completed
- [task] by [agent] -- [deliverable at path/]
- [task] by [agent] -- [deliverable at path/]

### Tool Mastery Completed
- [agent]: [tool] -- [key finding, one line]

### Blocked (needs morning attention)
- [task] -- [reason]

### Needs User Review
- [item needing decision]

### Agent Status at Morning
[list each agent: status, last heartbeat]
MEMEOF

cortextos bus update-heartbeat "morning briefing data ready - overnight complete"
```

---

## Event Logging

```bash
# Starting nighttime mode
cortextos bus log-event action nighttime_mode_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'

# Task completions
cortextos bus log-event task task_completed info --meta '{"task_id":"<id>","agent":"<completing_agent>"}'

# Tool mastery block complete
cortextos bus log-event action tool_mastery_complete info --meta '{"agent":"<agent>","tool":"<tool_name>"}'

# Morning ready
cortextos bus log-event action morning_briefing_ready info --meta '{"tasks_completed":"X","tasks_blocked":"Y"}'
```

---

## Philosophy

> Lower risk, higher autonomy. No external actions — internal building only.

The night is for making the user's next day easier. Dispatch, monitor, and coordinate — never act externally without them. The orchestrator's job overnight is to keep agents productive, fill gaps with tool mastery work, and prepare a clear morning briefing.

---

*This is the single source of truth for nighttime mode.*
