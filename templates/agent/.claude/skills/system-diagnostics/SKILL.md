---
name: system-diagnostics
description: "Something in the system feels stuck or wrong — tasks are not moving, an agent has gone quiet, goals have not been updated in days, or the orchestrator has asked for a system health report. You need to run a structured check: stale tasks, stale goals, overdue human tasks, fleet heartbeat status, and metrics. This is your diagnostic toolkit. Run it on every heartbeat (orchestrator) and whenever something seems off."
triggers: ["system health", "health check", "stale tasks", "stale goals", "fleet health", "system status", "what's stuck", "blocked tasks", "overdue tasks", "goal staleness", "collect metrics", "metrics", "system check", "something seems wrong", "agent not progressing", "work stalled", "nothing moving", "check everything", "full health check", "morning health check", "diagnose system", "task stuck", "goals not updated"]
---

# System Diagnostics

Use these to detect and surface problems before they become crises.

---

## Stale Task Detection

Find tasks that have been in-progress too long or pending without action:

```bash
cortextos bus check-stale-tasks
```

Flags:
- `in_progress` for more than 2 hours
- `pending` for more than 24 hours
- Human tasks with no update in 48 hours
- Tasks past their due date

**When to run:** Every heartbeat (orchestrator), on suspicion of stuck work (all agents).

---

## Goal Staleness Check

Detect agents whose GOALS.md hasn't been updated recently:

```bash
# Default threshold (7 days)
cortextos bus check-goal-staleness

# Custom threshold
cortextos bus check-goal-staleness --threshold 3

# JSON output for parsing
cortextos bus check-goal-staleness --json
```

**When to run:** Weekly, or when an agent seems directionless.

---

## Human Task Monitoring

Check for human-assigned tasks that are waiting too long:

```bash
cortextos bus check-human-tasks
```

Sends reminders for overdue human tasks. Run daily (orchestrator) or when blocked waiting on a human.

---

## Fleet Health Summary

Read all agent heartbeats at once:

```bash
cortextos bus read-all-heartbeats

# JSON for parsing
cortextos bus read-all-heartbeats --format json
```

Stale threshold: agent hasn't updated in >6h = investigate.

---

## Metrics Collection

Collect and record system metrics snapshot:

```bash
cortextos bus collect-metrics
```

Run nightly (analyst cron). Captures task counts, completion rates, agent activity.

---

## Full Health Check Sequence

Run this during morning review or when something feels off:

```bash
echo "=== Fleet Heartbeats ==="
cortextos bus read-all-heartbeats

echo "=== Stale Tasks ==="
cortextos bus check-stale-tasks

echo "=== Stale Goals ==="
cortextos bus check-goal-staleness

echo "=== Human Tasks ==="
cortextos bus check-human-tasks
```

Surface any findings to the user via Telegram if critical.

---

## Worked Example: Investigating a stale agent

An agent shows as stale on the dashboard (last heartbeat >2h ago).

**Step 1 -- Check heartbeat:**
```bash
cortextos bus read-all-heartbeats --format text
# Look for: last seen timestamp, status message
```

**Step 2 -- Check if process is running:**
```bash
cortextos status
# Look for: agent PID, uptime, model
```

**Step 3 -- Check event logs for errors:**
```bash
cat ~/.cortextos/cortextos1/orgs/revops-global/analytics/events/<agent>/$(date -u +%Y-%m-%d).jsonl | \
  python3 -c "import sys,json; lines=[json.loads(l) for l in sys.stdin]; errors=[l for l in lines if l.get('category')=='error']; print(f'{len(errors)} errors of {len(lines)} events')"
```

**Step 4 -- If stale >2h with no errors:** Agent is likely idle. Send a ping:
```bash
cortextos bus send-message <agent> normal "Health check -- are you active?"
```

**Step 5 -- If stale >2h with errors:** Restart the agent:
```bash
cortextos bus self-restart --reason "stale >2h with errors in event log"
```


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
