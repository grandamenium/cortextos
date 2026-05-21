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

`cortextos bus update-heartbeat <status>` — logs the heartbeat event automatically. No separate `log-event` call needed.

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

---

## Worked Examples

**Log a task completion:**
```bash
cortextos bus log-event action task_completed info \
  --meta '{"agent":"analyst","task_id":"N1-coordination-planes","title":"Coordination plane unification spike"}'
```

**Log a morning brief send:**
```bash
cortextos bus log-event action briefing_sent info \
  --meta '{"agent":"analyst","channel":"slack","date":"2026-04-25"}'
```

**Log a KB refresh:**
```bash
cortextos bus log-event action kb_refresh info \
  --meta '{"agent":"analyst","phase":"daily","doc_count_before":442,"doc_count_after":473,"delta":18}'
```

**Event naming conventions:**
- Use specific names: `task_completed`, `kb_refresh`, `theta_wave_complete`, `briefing_sent`
- NOT generic: `action_completed`, `work_done`, `update`
- Always include `agent` in metadata
- Include `task_id` when the event relates to a task


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
