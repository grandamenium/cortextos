# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-cron-fire heartbeat --interval 8h
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon — you don't need to poll for them. This step is a safety sweep for anything that wasn't ACK'd (e.g. a crash mid-processing).

Full reference: `.claude/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

## Step 3: Triage failure-keyword tasks (C21 — incident pickup latency)

Scan pending tasks for failure-trigger keywords. Any task whose title contains a failure keyword must be triaged immediately — not deferred to next session. Target: pickup latency ≤ next heartbeat cycle (~8h). Measurement baseline: N=5 incidents by 2026-05-11.

```bash
# Get pending tasks assigned to this agent
PENDING=$(cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending --format json 2>/dev/null)

# Failure keyword pattern (per feedback_failure_task_keywords rule)
FAILURE_TASKS=$(echo "$PENDING" | python3 -c "
import sys, json, re
tasks = json.load(sys.stdin)
pattern = re.compile(r'failure.trigger|ERROR|CRITICAL|exception|quota_exceeded|render exited|EACCES|ECONNREFUSED|Unauthorized|failed|crash', re.I)
for t in tasks:
    if pattern.search(t.get('title', '')):
        print(t['id'], '|', t['title'][:80])
" 2>/dev/null)

if [[ -n "$FAILURE_TASKS" ]]; then
  echo "[heartbeat] Failure tasks found — triaging immediately:"
  echo "$FAILURE_TASKS"
  # For each: move to in_progress and investigate before resuming normal heartbeat work
  # Do NOT defer these to the task-queue step below
fi
```

- If failure tasks found: investigate and resolve before proceeding to Step 4.
- If no failure tasks: continue silently.
- "Triage" means: mark in_progress, read the error, determine root cause, fix or escalate, complete the task with a result summary.

## Step 4: Check task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

Full reference: `.claude/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `.claude/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC) / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now — see `.claude/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

## Step 7: Resume work

Full reference: `.claude/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

If you are blocked, see `.claude/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `.claude/skills/approvals/SKILL.md`.

## Step 8: Guardrail self-check + stall detection

Full reference: `.claude/skills/guardrails-reference/SKILL.md`

Run stall detector (Option B — event log query, P2):
```bash
bash ../../scripts/check-stall.sh --agent $CTX_AGENT_NAME --window 120
```
If exit 1 (STALL_DETECTED): alert chief via `cortextos bus send-message chief normal 'devops stall detected — no real events in 2h during day mode. Investigate.'`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `.claude/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
