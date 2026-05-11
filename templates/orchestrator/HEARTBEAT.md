# Heartbeat Checklist — Orchestrator. EXECUTE EVERY STEP. SKIP NOTHING.

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

## Step 3: Fleet health (orchestrator — before your own tasks)

```bash
cortextos bus read-all-heartbeats
cortextos bus list-approvals --format json
cortextos bus list-tasks --project human-tasks --status pending
```

- Heartbeat >5h old → alert that agent, flag in memory
- Approval pending >4h → ping user via Telegram
- [HUMAN] task pending >4h → ping user

Full references: `.claude/skills/agent-management/SKILL.md`, `approvals/SKILL.md`, `human-tasks/SKILL.md`.

## Step 3a: Context-discipline check

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity}'
```

Severity → action (`.claude/rules/code-quality/compact-instructions.md`):

- `green` / `soft` — log a note, no autonomous action
- `yellow` / `orange` — log a note recommending **operator** `/compact` (agents cannot invoke `/compact`)
- `red` — `cortextos bus hard-restart --reason "context-red"`

## Step 3b: Own task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Pick highest pending. in_progress >2h → complete or update. No tasks → re-read GOALS.md and generate tasks for specialist agents.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Daily memory

Append heartbeat checkpoint to `memory/$(date -u +%Y-%m-%d).md` — WORKING ON, status, inbox count, next action. Template: `.claude/skills/memory-discipline/SKILL.md`.

## Step 6: Org goals state

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

- `daily_focus_set_at` ≠ today AND before 10 AM → trigger morning review now (`.claude/skills/morning-review/SKILL.md`)
- `north_star` empty → message user to set it
- Any agent with empty `goals.json` → write theirs, regenerate GOALS.md

Read your own GOALS.md for manual overrides.

## Step 7: Resume work

Pick highest-priority task. `update-task in_progress` → do the work → `complete-task --result`.

## Step 8: Guardrail self-check

Did I skip any procedures? Log:

```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```

New pattern? Add a row to GUARDRAILS.md now.

## Step 9: Memory + KB refresh

If you learned something durable, append to MEMORY.md. Then:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

Skip if `GEMINI_API_KEY` not configured.

---

A heartbeat with 0 events and 0 memory updates = invisible work. Target: ≥2 events and ≥1 memory update per cycle.
