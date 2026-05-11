# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

Runs on your heartbeat cron (every 4h). Full step references: `.claude/skills/heartbeat/SKILL.md`.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

`update-heartbeat` (Step 1) refreshes the dashboard status-string field. `log-event heartbeat agent_heartbeat` (Step 4) appends to the activity feed. Both are required every cycle — not interchangeable.

## Step 2: Sweep inbox

Fast-checker delivers in real time; this is a safety sweep for un-ACK'd messages.

```bash
cortextos bus check-inbox
# for each: process, then cortextos bus ack-inbox "<id>"
```

Un-ACK'd messages re-deliver after 5 min. Target: 0 after the sweep.

## Step 3: Tasks + stale detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Pick highest-priority pending. For in_progress >2h: complete now or update status. If no tasks: re-read GOALS.md, then ping the orchestrator. Stale tasks show as broken on the dashboard.

## Step 3a: Context-discipline check

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity}'
```

Severity → action (full table: `.claude/rules/code-quality/compact-instructions.md`):

- `green` / `soft` — log a note, no autonomous action
- `yellow` / `orange` — log a note recommending **operator** `/compact` (agents cannot invoke `/compact`)
- `red` — `cortextos bus hard-restart --reason "context-red"` (Layer 1a agent-self primitive)

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Daily memory

Append today's checkpoint to `memory/$(date -u +%Y-%m-%d).md` — WORKING ON, status, inbox count, next action. Full template: `.claude/skills/memory-discipline/SKILL.md`.

## Step 6: GOALS.md check

Re-read GOALS.md. If goals updated today but you have no tasks → create them. If stale >24h → ping orchestrator for refresh.

## Step 7: Resume work

Pick highest-priority task. `update-task in_progress` when starting, `complete-task --result` when done. Tasks trace back to current goals.

## Step 8: Guardrail self-check

Did I skip any procedures this cycle? If yes, log it:

```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```

New pattern caught? Add a row to GUARDRAILS.md now.

## Step 9: Memory + KB refresh (if applicable)

If you learned something durable, append to MEMORY.md. Then refresh the KB:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

Runs on every heartbeat. Skip if `GEMINI_API_KEY` is not configured.

---

A heartbeat with 0 events logged and 0 memory updates means you did nothing visible. Target: ≥2 events and ≥1 memory update per cycle.
