---
name: system-diagnostics
description: "Something in the system feels stuck or wrong — tasks are not moving, an agent has gone quiet, goals have not been updated in days, or the orchestrator has asked for a system health report. You need to run a structured check: stale tasks, stale goals, overdue human tasks, fleet heartbeat status, and metrics. This is your diagnostic toolkit. Run it on every heartbeat (orchestrator) and whenever something seems off."
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
