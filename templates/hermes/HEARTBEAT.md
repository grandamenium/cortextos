# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.

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

Un-ACK'd messages are re-delivered in 5 minutes.
Target: 0 un-ACK'd messages after this step.

## Step 3: Check task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- Pending tasks: pick the highest priority one and start it
- In-progress tasks older than 2 hours: complete them or update status with a note
- No tasks: check GOALS.md for objectives, then check with orchestrator

## Step 3a: Context-discipline check

Refresh your context-pct snapshot and decide whether to act. The monitor reads your Claude Code transcript, computes loaded-context %, and writes `~/.cortextos/$CTX_INSTANCE_ID/state/$CTX_AGENT_NAME/context-pct.json`. A `context_threshold_crossed` event is emitted automatically when severity is non-green.

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity, current_loaded_tokens, context_limit, model}'
```

Severity → action (full reference: `.claude/rules/code-quality/compact-instructions.md`):

- `green` — no action
- `soft` — log a heartbeat note that context is elevated; no autonomous action
- `yellow` — log a heartbeat note recommending **operator** `/compact` at the next phase boundary; agent has no autonomous action (`/compact` is a Claude Code slash command typed by the operator — agents cannot invoke it from a tool call; see `code-quality/agent-side-compact-not-invokable.md`)
- `orange` — log a heartbeat note recommending **operator** `/compact` NOW; agent has no autonomous action. If the operator is unavailable and the situation is unsafe, the only agent-self fallback is `cortextos bus hard-restart` (preserves durable memory; loses live conversation)
- `red` — `cortextos bus hard-restart --reason "context-red"` (Layer 1a agent-self primitive — `/compact` is too late at this severity)

If `context-update` exits non-zero (no transcript found): treat as unknown, skip threshold action this cycle, log warning.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M)
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Re-index memory to KB

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

## Step 7: Check GOALS.md

Read GOALS.md for any new objectives. If goals changed, create tasks:
```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME
```

## Step 8: Resume work

Pick your highest priority task and work on it.

```bash
cortextos bus update-task "<task_id>" in_progress
# ... do the work ...
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
