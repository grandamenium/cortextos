---
name: tasks
description: "You are about to start any meaningful piece of work — a research task, a build, a draft, a deployment, anything with a deliverable. Before you begin, create a task. During the work, mark it in_progress and write WORKING ON to daily memory. When done, complete it with a result summary and log a task_completed event. If you are blocked, set the task to blocked with the reason. If a human needs to do something first, assign it to them. Without a task, your work is invisible to the dashboard and the user."
---

# Task System

Every significant piece of work must have a corresponding task. Tasks enable coordination, accountability, and measurable progress.

## Task Types

- **Agent tasks** - Work executed autonomously by the assigned agent
- **Human tasks** - Requires human decision, input, or approval (assigned_to=human)

## Lifecycle

### 1. Create (BEFORE starting work)
```bash
cortextos bus create-task "<title>" --desc "<description>" [--assignee <agent>] [--priority <p>] [--project <name>]
```

### 2. Mark in progress
```bash
cortextos bus update-task <task_id> in_progress
```

### 3. Execute the work

### 4. Complete
```bash
cortextos bus complete-task <task_id> --result "[output summary]"
```

### 5. Log KPI (if measurable)
```bash
cortextos bus log-event task task_completed info --meta '{"task_id":"ID","kpi_key":"metric_name","value":1}'
```

## The `needs_approval` Field

**true** - external actions: sending emails, merging PRs, deploying, public announcements
**false** - internal work: research, drafts, feature branches, testing

Tasks with `needs_approval: true` create an approval item that must be reviewed before executing external actions.

## Script Reference

| Action | Command |
|--------|---------|
| Create | `cortextos bus create-task "<title>" --desc "<desc>" [--assignee <a>] [--priority <p>]` |
| List | `cortextos bus list-tasks [--status S] [--agent A] [--priority P]` |
| Update | `cortextos bus update-task <id> <status>` |
| Complete | `cortextos bus complete-task <id> --result "[summary]"` |
| Log event | `cortextos bus log-event <category> <event> <severity> --meta '[json]'` |

**Statuses:** pending, in_progress, blocked, completed

**Priorities:** urgent, high, normal, low

## Best Practices

- **Always create before starting** - ensures tracking and coordination
- **Be specific** - clear titles, descriptions with success criteria
- **Complete thoroughly** - include what was accomplished and where outputs are
- **Log KPIs** - when work advances a measurable goal
