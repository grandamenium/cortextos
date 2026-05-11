# Heartbeat Checklist — Analyst. EXECUTE EVERY STEP. SKIP NOTHING.

Runs every 4h. Full step references: `.claude/skills/heartbeat/SKILL.md`.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary>"
```

`update-heartbeat` refreshes the dashboard status field; `log-event heartbeat agent_heartbeat` (Step 4) appends to activity. Both required, not interchangeable.

## Step 2: Sweep inbox

```bash
cortextos bus check-inbox
# for each: process, then cortextos bus ack-inbox "<id>"
```

Un-ACK'd messages re-deliver after 5 min. Target: 0 after the sweep.

## Step 3: System health check (analyst — before your own tasks)

```bash
cortextos bus read-all-heartbeats
cortextos bus list-tasks --status in_progress | head -20
```

For each agent: heartbeat >5h → message that agent + flag in memory. >5 errors in last hour → escalate to orchestrator. >3 restarts in last hour → flag a stability incident.

## Step 3a: Context-discipline check

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity}'
```

Severity → action (`.claude/rules/code-quality/compact-instructions.md`):

- `green` / `soft` — log a note, no autonomous action
- `yellow` / `orange` — log a note recommending **operator** `/compact` (agents cannot invoke `/compact`)
- `red` — `cortextos bus hard-restart --reason "context-red"`

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Daily memory

Append heartbeat checkpoint to `memory/$(date -u +%Y-%m-%d).md` — WORKING ON, status, inbox count, next action. Template: `.claude/skills/memory-discipline/SKILL.md`.

## Step 6: Metrics + anomaly scan (analyst-specific)

```bash
cortextos bus collect-metrics
cat ~/.cortextos/$CTX_INSTANCE_ID/analytics/reports/latest.json | jq '.summary'
cat ~/.cortextos/$CTX_INSTANCE_ID/analytics/events/$CTX_AGENT_NAME/$(date -u +%Y-%m-%d).jsonl \
  | jq 'select(.category == "error")'
```

Anomalies → report to orchestrator (`task_dispatched` to investigate, or direct message).

## Step 7: Resume work

Pick highest-priority task. `update-task in_progress` when starting, `complete-task --result` when done.

## Step 8: Boss-failover gate (Bounded authority)

Check whether the BL-003 phase-3 condition holds — see GUARDRAILS.md "Analyst-Specific". Both conditions must be true:

1. Boss heartbeat is stale (boss can't act for itself).
2. A `profile_quota_exhausted` event for boss appeared in the bus event log within the last 5 min.

If both hold:
```bash
cortextos profile-failover --agent boss --trigger <event_id>
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Boss failover executed — trigger event_id=<id>"
```

If only one is true → create an approval, escalate to Saurav, do NOT edit `boss/config.json` directly.

## Step 9: Memory + KB refresh

If you learned something durable, append to MEMORY.md. Then:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

Skip if `GEMINI_API_KEY` not configured.

---

A heartbeat with 0 events and 0 memory updates = invisible work. Target: ≥2 events and ≥1 memory update per cycle.
