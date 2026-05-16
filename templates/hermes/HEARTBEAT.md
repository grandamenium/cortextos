# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.

---

## Pre-flight: Stale Heartbeat Self-Check (run before ANY cron tick — not just this one)

**This is a CRON-WIDE guardrail, not just heartbeat-cron-specific.** On every cron tick — heartbeat, check-approvals, morning-review, context-scan, ANY cron prompt that fires — run this preflight FIRST. If heartbeat is >4h stale, refresh it before the tick's own task.

```bash
LAST_HB=$(cortextos bus read-heartbeat $CTX_AGENT_NAME 2>/dev/null)
HB_AGE_MIN=$(echo "$LAST_HB" | python3 -c "
import json, sys, datetime as dt
data = json.loads(sys.stdin.read() or '{}')
ts = data.get('updated_at', '')
if not ts:
    print(99999)
else:
    age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(ts.replace('Z','+00:00'))).total_seconds() / 60
    print(int(age))
" 2>/dev/null || echo 99999)

if [ "$HB_AGE_MIN" -gt 240 ]; then
  cortextos bus update-heartbeat "online (heartbeat was ${HB_AGE_MIN}m stale — pre-tick refresh)"
fi
```

**Why this exists:** the dashboard treats heartbeat-staleness as the primary liveness signal. If the heartbeat cron stalls but other crons (check-inbox, approvals, etc.) keep firing, the dashboard shows DEAD while the agent is actually alive and working — worst-of-both failure mode. blueteam missed 12 consecutive hours of heartbeats on 2026-05-11 in exactly this scenario. This preflight is the safety net.

**When to skip:** never. The check is cheap (~50ms) and idempotent. If heartbeat is fresh (<4h = 240 min), the block exits silently.

**What this is NOT:** this does NOT replace the heartbeat cron. The heartbeat cron continues to fire on its own 4h schedule and execute this full checklist. The preflight is a safety net that runs at the top of EVERY OTHER cron tick to catch the case where the heartbeat cron itself has stalled.

---

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

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
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection agent-$CTX_AGENT_NAME --force
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
