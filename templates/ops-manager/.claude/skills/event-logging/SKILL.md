---
name: event-logging
description: "You have just completed a task, started a session, dispatched work to another agent, finished a research cycle, or taken any significant action — and you need to record it so the dashboard activity feed shows your work. Without logging, you are invisible. Every session start, task completion, and major coordination action must produce at least one event. If you have been active but see no events in the dashboard, you have been logging nothing."
triggers: ["log event", "log activity", "activity feed", "event log", "track activity", "record event", "log completion", "log session", "no events", "invisible on dashboard", "dashboard empty", "nothing showing", "log task", "log coordination", "log research", "session start event", "task completed event", "log error", "log warning"]
---

# Event Logging

Events are how the dashboard activity feed knows what you're doing. No events = you look dead. Log aggressively.

---

## Command

```bash
cortextos bus log-event <category> <event_name> <severity> [--meta '<json>']
```

| Parameter | Options |
|-----------|---------|
| category | `action` `task` `heartbeat` `message` `approval` `error` `metric` `milestone` |
| severity | `info` `warning` `error` `critical` |

---

## Required Events (log every session)

### Session start
```bash
cortextos bus log-event action session_start info \
  --meta "{\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Session end
```bash
cortextos bus log-event action session_end info \
  --meta "{\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Task completed
```bash
cortextos bus log-event task task_completed info \
  --meta "{\"task_id\":\"$TASK_ID\",\"agent\":\"$CTX_AGENT_NAME\",\"summary\":\"<what was done>\"}"
```

### Heartbeat
```bash
cortextos bus log-event heartbeat agent_heartbeat info \
  --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"status\":\"active\"}"
```

---

## Common Event Patterns

### Research completed
```bash
cortextos bus log-event action research_complete info \
  --meta "{\"topic\":\"<topic>\",\"findings\":3,\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Message dispatched to agent
```bash
cortextos bus log-event message message_sent info \
  --meta "{\"to\":\"<agent>\",\"priority\":\"normal\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Error encountered
```bash
cortextos bus log-event error <operation>_failed error \
  --meta "{\"operation\":\"<what failed>\",\"error\":\"<message>\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Approval created
```bash
cortextos bus log-event action approval_created info \
  --meta "{\"approval_id\":\"$APPR_ID\",\"category\":\"<cat>\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

---

## Orchestrator-Specific Events

```bash
# Task dispatched to specialist
cortextos bus log-event action task_dispatched info \
  --meta "{\"to\":\"<agent>\",\"task\":\"<title>\",\"agent\":\"$CTX_AGENT_NAME\"}"

# Status briefing sent to user
cortextos bus log-event action briefing_sent info \
  --meta "{\"type\":\"status_update\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

---

## Target

- Minimum 3 events per active session
- Every task completion = 1 event
- Every session start/end = 1 event each
- Every significant coordination action = 1 event
