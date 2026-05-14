---
name: heartbeat
model: claude-haiku-4-5-20251001
effort: low
description: "Your heartbeat cron has fired and you need to update your status so the dashboard shows you as alive — AND run the approvals sweep folded in from the former check-approvals cron (RFC #8). Or you are checking whether another agent is responsive before sending them work. Or an agent appears offline or stale in the dashboard and you need to investigate whether their session is still running. A dead heartbeat means the system thinks you are down — update it proactively and check fleet health on every heartbeat cycle."
triggers: ["heartbeat", "update heartbeat", "check health", "agent health", "fleet health", "agent status", "is agent alive", "agent offline", "agent stale", "read heartbeats", "heartbeat cron", "i'm alive", "prove alive", "agent not responding", "stale agent", "check fleet", "fleet status", "who is online", "agent last seen"]
---

# Heartbeat

The heartbeat is how the dashboard and other agents know you are alive. If you stop updating it, you appear DEAD.

---

## Your Heartbeat Cron

Your `config.json` has a heartbeat cron (default every 4h). When it fires:

### Phase 0: Conditional fire (gate, opt-in via flag)

If `config.json` has `heartbeat.event_driven: true`, run this gate FIRST. If `event_driven` is absent or false (default), skip Phase 0 entirely and run the full Steps 1–4 + Step 5 sweep below — zero behavior change for unflagged agents.

When the gate is enabled, most quiet heartbeats become a 1-line noop. The Sunday 4 AM safety-net cron forces a full scan once a week regardless, catching anything the predicate might miss.

**Predicate — RUN the full heartbeat (Steps 1–5) if ANY of these is true since the last `agent_heartbeat` event:**

| Signal | How to detect |
|---|---|
| New inbox message | `event.event == "inbox_arrival"` |
| Approval state changed | `event.category == "approval"` |
| Anomaly fired | `event.severity in [error, critical]` |
| In-progress task >2h stale | live `list-tasks --status in_progress` filtered by `(now - updated_at) > 7200` |

**If none match → NOOP heartbeat:** 1-line memory + heartbeat update + log + done. Skip Steps 1–5 (Step 5 approvals sweep folded into the predicate above — no separate poll needed when event-driven).

```bash
# Read flag (treat absent as false)
EVENT_DRIVEN=$(jq -r '.heartbeat.event_driven // false' "$CTX_AGENT_DIR/config.json" 2>/dev/null)
HEARTBEAT_NOOP=false

if [[ "$EVENT_DRIVEN" == "true" ]]; then
  # 0a. Find the last agent_heartbeat event timestamp.
  # Scope to last 2 days of JSONL files to bound work per heartbeat cycle.
  LAST_FIRE=$(find ~/.cortextos/"$CTX_INSTANCE_ID"/orgs/"$CTX_ORG"/analytics/events/"$CTX_AGENT_NAME" \
    -name '*.jsonl' -mtime -2 2>/dev/null \
    | xargs -I{} cat {} 2>/dev/null \
    | jq -r 'select(.event == "agent_heartbeat") | .timestamp' \
    | sort | tail -1)

  # 0b. Count signal events since LAST_FIRE.
  # Use chronological (epoch) comparison via fromdateiso8601, NOT lexicographic
  # string > — protects against timestamps that ever omit Z or carry local offsets.
  if [[ -n "$LAST_FIRE" ]]; then
    NOTEWORTHY=$(find ~/.cortextos/"$CTX_INSTANCE_ID"/orgs/"$CTX_ORG"/analytics/events/"$CTX_AGENT_NAME" \
      -name '*.jsonl' -mtime -2 2>/dev/null \
      | xargs -I{} cat {} 2>/dev/null \
      | jq --arg t "$LAST_FIRE" -c 'select((.timestamp | fromdateiso8601) > ($t | fromdateiso8601)) | select(
          .event == "inbox_arrival"
          or .category == "approval"
          or .severity == "error"
          or .severity == "critical"
        )' | jq -s 'length')
  else
    NOTEWORTHY=1  # first run ever — never noop
  fi

  # 0c. Cheap inline stale-task check (>2h in_progress without update)
  STALE_INPROG=$(cortextos bus list-tasks --agent "$CTX_AGENT_NAME" --status in_progress --json 2>/dev/null \
    | jq '[.[] | select((now - (.updated_at | fromdateiso8601)) > 7200)] | length' 2>/dev/null || echo 0)

  # 0d. Decide
  if [[ "$NOTEWORTHY" -eq 0 && "$STALE_INPROG" -eq 0 ]]; then
    cortextos bus update-heartbeat "noop heartbeat — no inbox/approval/error/stale signals since $LAST_FIRE"
    cortextos bus log-event heartbeat agent_heartbeat info \
      --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"status\":\"active\",\"mode\":\"noop\"}"
    HEARTBEAT_NOOP=true
    # NOTE: do NOT use `exit 0` here — agents run in a persistent PTY shell;
    # exit terminates the whole shell and triggers a watchdog restart, turning
    # the NOOP optimization into a self-inflicted restart storm. Set the
    # HEARTBEAT_NOOP guard and let the wrapper below skip Steps 1–5 instead.
  fi
  # Otherwise → fall through to Steps 1–5 below
fi
```

If the predicate skips for 3+ consecutive scheduled fires AND the dashboard never went stale, that is the steady-state signal — note it in your next memory entry. If the dashboard DID go stale despite passes, the predicate is too loose; surface to orchestrator for tightening.

### Steps 1–4 (full heartbeat — runs when gate is off OR predicate matched)

```bash
if [[ "$HEARTBEAT_NOOP" != "true" ]]; then
  # 1. Update your heartbeat with what you're doing
  cortextos bus update-heartbeat "WORKING ON: <current task summary>"

  # 2. Check inbox for messages
  cortextos bus check-inbox

  # 3. Log heartbeat event
  cortextos bus log-event heartbeat agent_heartbeat info \
    --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"status\":\"active\"}"

  # 4. Check your task queue for anything stale
  # MANDATORY — do not skip even when running alongside other crons
  cortextos bus list-tasks --agent "$CTX_AGENT_NAME" --status in_progress
  # Flag any task that has been in_progress for >2h without a memory update
fi
```

---

## Step 5: Approvals Sweep (folded from check-approvals cron, RFC #8)

The standalone `check-approvals` cron was retired — heartbeat absorbs it. Run this sweep on every heartbeat cycle.

```bash
if [[ "$HEARTBEAT_NOOP" != "true" ]]; then
  # 5a. Confirm the sweep cycle fired (replaces the old approvals_cron_fired event)
  cortextos bus log-event action approvals_cron_fired info \
    --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"source\":\"heartbeat-fold\"}"

  # 5b. Human task queue — pending tasks assigned to a human
  cortextos bus list-tasks --status pending
  # For each task assigned to "human" or "david":
  #   - If created >24h ago with no update: send ONE Telegram reminder
  #   - If blocking agent work: surface explicitly with blocking context
  #   - If night mode (after 19:30 ET): defer reminders to next morning-review

  # 5c. Pending approvals — list and re-ping if stale
  cortextos bus list-approvals --format json
fi
```

For each pending approval in 5c, check `created_at`:
- If pending >4h AND it's day mode (07:30-19:30 ET) AND no re-ping has been sent yet for this approval → send ONE re-ping:
  ```bash
  cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
    "Reminder: approval for '<title>' is still pending. No rush, just flagging."
  ```
- Send only ONE re-ping per approval. Do not spam.
- Night mode (after 19:30 ET): skip re-pings, defer to next day's first heartbeat.

If both queues are empty, no Telegrams go out. The 5a `log-event` confirms the sweep fired regardless.

For full approvals workflow (creating new approvals, blocking tasks, etc.) see `.claude/skills/approvals/SKILL.md` — that skill is still loaded on-demand for the create/block path; only the periodic sweep moved here.

---

## Concurrent Cron Handling

When heartbeat fires at the same time as another cron (e.g., approvals):
- Run BOTH skill sequences fully — do not merge or abbreviate
- Both log-event calls must execute separately
- Both memory entries must be written
- Do not drop step 3 or step 4 because another cron is running

## Degraded Shell Handling

If shell commands fail (exit code 1 on all commands):
1. Alert David via direct Telegram API using WebFetch
2. Write a degraded heartbeat memory entry using the Write tool
3. Do not claim "heartbeat complete" — mark as "heartbeat degraded, shell broken"

---

## Updating Heartbeat

```bash
cortextos bus update-heartbeat "<one sentence: what you are doing right now>"
```

Call this:
- On every heartbeat cron fire
- On session start (before sending online notification)
- When starting a new significant task
- Before going into a long-running operation

**Never claim a status you haven't verified.** If your crons were reset on restart, check CronList before saying "crons running."

---

## Reading Fleet Heartbeats

```bash
# All agents in the org
cortextos bus read-all-heartbeats

# JSON format for parsing
cortextos bus read-all-heartbeats --format json
```

Returns: agent name, status, last update timestamp, current task.

**Stale threshold:** An agent that hasn't updated in >6h should be investigated. Check their status via `cortextos status` or their heartbeat file.

---

## Checking a Specific Agent

```bash
# Read their heartbeat file directly
cat "$CTX_ROOT/state/<agent-name>/heartbeat.json"

# Check agent status via daemon
cortextos status

# Check PM2 process status
pm2 list
```

---

## Heartbeat File Schema

```json
{
  "agent": "agent-name",
  "status": "active | idle | crashed",
  "timestamp": "2026-04-01T12:00:00Z",
  "current_task": "What I'm doing right now"
}
```

Location: `$CTX_ROOT/state/{agent}/heartbeat.json`
