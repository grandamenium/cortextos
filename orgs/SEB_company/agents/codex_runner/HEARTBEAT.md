# Heartbeat Checklist

Runs every 4h. Execute ALL steps in order — skipping = broken system, dashboard tracks compliance.

## Step 0: Tier 3 context gate (NEW 2026-05-25)

Before any other heartbeat work, check context plus task/inbox state:
```bash
PCT=$(jq -r .used_percentage < "$CTX_ROOT/state/$CTX_AGENT_NAME/context_status.json" 2>/dev/null | cut -d. -f1)
IN_PROGRESS_TASK_EXISTS=$(cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress --format json 2>/dev/null | jq -r 'if length > 0 then "true" else "false" end')
NEW_DISPATCH_ARRIVED=$(cortextos bus check-inbox 2>/dev/null | jq -r 'if length > 0 then "true" else "false" end')
CAPPED=$([ "${PCT:-0}" -ge 95 ] && echo true || echo false)
```
Self-restart ONLY IF one of these is true:
- `PCT >= 70` AND `IN_PROGRESS_TASK_EXISTS=true`
- `CAPPED=true` AND `NEW_DISPATCH_ARRIVED=true`

```bash
cortextos bus hard-restart --reason "Tier 3 restart: context $PCT%, in_progress=$IN_PROGRESS_TASK_EXISTS, capped=$CAPPED, new_dispatch=$NEW_DISPATCH_ARRIVED"
```
Skip the rest of heartbeat — fresh session will run its own.

Otherwise HOLD parked-at-100% state. Do not restart. Do not Telegram. Continue heartbeat via bus-only updates.

## Step 1: update-heartbeat FIRST
```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```
Dashboard status field. If fails → fix before anything else.

## Step 2: Sweep inbox + ACK
Ref: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`
```bash
cortextos bus check-inbox
# For each msg: cortextos bus ack-inbox "<message_id>"
```
Un-ACK'd msgs re-deliver after 5min. Telegram-shape msgs (`=== TELEGRAM from`) should have been replied at arrival — if not, reply NOW.

## Step 3: Task queue + stale detection
Ref: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```
- Pending → pick highest priority
- in_progress >2h → complete OR update with note
- No tasks → check GOALS.md → message orchestrator

## Step 4: log-event heartbeat
```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```
NOT same as Step 1 — this appends to activity feed (JSONL). Both required.

## Step 5: Daily memory
Ref: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`
```bash
TODAY=$(date -u +%Y-%m-%d); LOCAL=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat $(date -u +%H:%M UTC) / $LOCAL
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N processed>
- Next: <next action>
MEMORY
```

## Step 6: GOALS.md check
- Stale >24h → request refresh from orchestrator
- No goals → message orchestrator (don't idle)

## Step 7: Resume work
Highest-priority task → trace to current goals.
```bash
cortextos bus update-task "<id>" in_progress
# when done:
cortextos bus complete-task "<id>" --result "<summary>"
```
Blocked? See `plugins/cortextos-agent-skills/skills/human-tasks/SKILL.md`.

## Step 8: Guardrail self-check
Did I skip a procedure? Rationalize not doing something?
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```
New pattern worth a guardrail? Add to GUARDRAILS.md.

## Step 9: MEMORY.md update (if applicable)
Patterns / user preferences / system behaviors learned this cycle → append.

## Step 10: KB re-ingest
```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```
Skip if GEMINI_API_KEY unset.

---

Target: ≥2 events + ≥1 memory update per cycle. Invisible work = wasted work.
