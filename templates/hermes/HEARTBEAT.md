# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 1b: Cron survival check + dump live CronList (CRITICAL — closes the 7-day silent cliff)

CronCreate auto-expires after 7 days. Without this check, crons silently disappear and the agent goes DEAD until something nudges it. The daemon also polls `state/<agent>/cron-list.json` (your last dump) and injects a forced-recreate nudge when a cron in `config.json` is missing from your live list — so this dump every heartbeat is what closes the silent cliff.

1. Call `CronList`. Cross-reference each live entry against `config.json`'s `crons[]` by prompt text.
2. For ANY cron in `config.json` not in the live `CronList` output, recreate it with `CronCreate` using the **cron expression** (or interval converted to a cron expression) and the verbatim `prompt` from `config.json`. Do NOT use `/loop` — for intervals ≥60 minutes it pops `AskUserQuestion`, which you cannot answer in this context.
3. Dump the live CronList to `cron-list.json` as a JSON array of `{name, prompt}` objects (one per live cron). Match each live entry's prompt back to a `config.json` name where possible; pass the verbatim prompt either way:

```bash
# Replace the inline array with the actual CronList contents you just observed.
echo '[{"name":"<config-name>","prompt":"<verbatim cron prompt>"},...]' \
  | cortextos bus update-cron-list
```

Log any recreation:

```bash
cortextos bus log-event action cron_recreated info --meta '{"agent":"'$CTX_AGENT_NAME'","cron":"<name>"}'
```

If `cron-list.json` is not refreshed for >1h, the daemon's mismatch detector skips silently — so don't miss this step.

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
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
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
