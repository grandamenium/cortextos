# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
# Check all agent heartbeats — flag any silent for >5 hours
cortextos bus read-all-heartbeats

# Check for agents with no recent activity
cortextos bus list-tasks --status in_progress 2>/dev/null | head -20
```

For each agent: if heartbeat is older than 5 hours, send a message to that agent:
```bash
cortextos bus send-message <agent_name> normal "Heartbeat check: are you running? Last heartbeat was more than 5 hours ago."
```

If an agent is unresponsive for >8 hours, notify the orchestrator and log the issue:
```bash
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> appears unresponsive — last heartbeat >8h ago. May need restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","hours_silent":8}'
```

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 3a: Context-discipline check

Refresh your context-pct snapshot and decide whether to act. The monitor reads your Claude Code transcript, computes loaded-context %, and writes `~/.cortextos/$CTX_INSTANCE_ID/state/$CTX_AGENT_NAME/context-pct.json`. A `context_threshold_crossed` event is emitted automatically when severity is non-green.

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity, current_loaded_tokens, context_limit, model}'
```

Severity → action (full reference: `.claude/rules/code-quality/compact-instructions.md`):

- `green` — no action
- `soft` — log a heartbeat note that context is elevated; no `/compact` yet
- `yellow` — schedule `/compact` at the **next** phase boundary (commit first, then compact)
- `orange` — `/compact` **now** at a safe boundary; if no boundary reachable, run the *Mid-task emergency* template
- `red` — `cortextos bus hard-restart --reason "context-red"`; `/compact` at this point is too late

If `context-update` exits non-zero (no transcript found): treat as unknown, skip threshold action this cycle, log warning.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

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

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Boss-failover check (BL-003 phase 3)

If boss is stale AND a `profile_quota_exhausted` event for boss
appears in the recent event log, you have a bounded authority to
edit `boss/config.json` and issue a soft-restart on boss's behalf
(boss can't run the failover skill if its own session has died).

```bash
# Is boss stale?
BOSS_AGE_MINUTES=$(cortextos bus read-heartbeat $CTX_ORCHESTRATOR_AGENT --age-minutes 2>/dev/null || echo 999)

# Did boss quota-exhaust in the last 5 minutes?
RECENT_EXHAUST=$(cortextos bus list-events --event profile_quota_exhausted --agent $CTX_ORCHESTRATOR_AGENT --since 5m --json 2>/dev/null | jq 'length')
```

If boss is stale AND `$RECENT_EXHAUST > 0`:

```bash
# Use the same atomic primitive boss would have used on itself
cortextos profile-failover --agent $CTX_ORCHESTRATOR_AGENT --trigger <event_id>
```

On exit 0, log the failover and notify Saurav:
```bash
cortextos bus log-event action analyst_boss_failover info --meta '{"trigger_event_id":"<id>","reason":"boss-quota-exhausted-and-stale"}'
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "🔄 boss failed over to fallback (boss-quota-exhausted, analyst executed). Soft-restart dispatched."
```

On exit non-zero, notify Saurav and stop — your authority is
bounded to this exact condition (see `GUARDRAILS.md`). Outside it,
edits to `boss/config.json` require explicit user approval.

## Step 9: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
