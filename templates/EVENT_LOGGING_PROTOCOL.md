# Event logging — fleet protocol

Reference for every agent. Re-read when adding a new event type or wiring a new code path that should be visible on the dashboard's Activity feed.

## Why log

The dashboard's Activity feed reads `~/.cortextos/$CTX_INSTANCE_ID/analytics/events/$CTX_AGENT_NAME/*.jsonl`. If you don't log, your work is invisible.

- **Target:** ≥ 3 events per active session.
- **Consequence:** Effectiveness score = 0% on the dashboard. Orchestrator can't see what you did.

## Mandatory events (every agent)

```bash
# Session start (one per session)
cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'

# Task completion (one per task)
cortextos bus log-event task task_completed info --meta '{"task_id":"<id>","agent":"'$CTX_AGENT_NAME'"}'
```

## Role-specific events

**Orchestrator / boss:**

```bash
cortextos bus log-event action task_dispatched info --meta '{"to":"<agent>","task":"<title>"}'
cortextos bus log-event action briefing_sent info --meta '{"type":"morning_review"}'
cortextos bus log-event action briefing_sent info --meta '{"type":"evening_review"}'
cortextos bus log-event action fleet_context_propagated info --meta '{"telegram_msg_id":<id>,"propagated_to":[<names>],"propagated_at":"<UTC ts>"}'
```

**Engineer / coding agents:**

```bash
cortextos bus log-event action build_passed info --meta '{"branch":"<name>","sha":"<sha7>"}'
cortextos bus log-event action pr_opened info --meta '{"pr":"<num>","branch":"<name>"}'
```

**Analyst:**

```bash
cortextos bus log-event action metrics_collected info --meta '{"window":"24h"}'
cortextos bus log-event action anomaly_detected warning --meta '{"agent":"<n>","kind":"<kind>"}'
```

## Categories

- `action` — discrete agent action (most common)
- `task` — task lifecycle (created, in_progress, completed)
- `restart` — fresh-restart, soft-restart, daemon respawn
- `error` — failed shell command, hook failure, dispatch error
- `comms` — outbound telegram / agent-to-agent message
- `kpi` — manual metric emit

## Severity

`info` for normal flow, `warning` for noteworthy-but-not-broken, `error` for failure paths.

## Meta keys (load-bearing — keep stable)

- `agent` — which agent (auto-filled by some bus commands; pass explicitly for clarity)
- `task_id` — for task events
- `pr` / `branch` / `sha` — for git-related
- `to` / `from` — for routing events
- `dispatch_msg_id` — for fresh-restart / skip events

## Anti-patterns

- **Logging the same event twice for one action.** One per logical action.
- **Logging without `meta`.** The Activity feed groups on meta keys; absence forces "Unknown" buckets.
- **Free-form action names that change every session.** Pick a stable verb (`task_completed`, `pr_opened`); don't write `finished_task_42` once and `finished_task_43` next time.
- **Skipping logs because "the heartbeat covers it".** Heartbeat = liveness signal. Events = work signal. Distinct purposes.
