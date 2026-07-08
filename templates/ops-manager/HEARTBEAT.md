# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). It exists to prove you're
alive on the dashboard between daily reviews — it is NOT the daily review
itself (that's `.claude/skills/daily-ops-review/SKILL.md`, on its own cron).

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence status>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

ACK every message:
```bash
cortextos bus ack-inbox "<message_id>"
```

You should rarely have inbox traffic — your role doesn't do task work. If you
see a task request outside the daily review, see GUARDRAILS.md's Role
Boundary section before responding.

## Step 3: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 4: Confirm the daily review ran

```bash
TODAY=$(date -u +%Y-%m-%d)
grep "Daily Ops Review" memory/${TODAY}.md 2>/dev/null || echo "Daily review has not run yet today"
```

If it's well past your scheduled review time and there's no entry, run
`.claude/skills/daily-ops-review/SKILL.md` now — don't wait for the cron to
retry on its own.
