---
name: task-reflection
description: "You just finished a task — completed it, marked it done, told someone it was shipped. Or a 'WORKING ON' entry just turned into a result. This is when you write a 3-line reflection (WORKED / FAILED / CHANGE) so the fleet learns. Without reflections, every agent re-learns the same lessons. With them, patterns accumulate in the daily memory and surface to MEMORY.md weekly. Hermes protocol #1."
triggers: ["task complete", "completed task", "task finished", "reflect on task", "what worked", "task lessons", "task reflection", "post-task", "after task", "task retrospective"]
---

# Task Reflection (Hermes Protocol #1)

After every task you complete with `cortextos bus complete-task`, write a 3-line reflection so the lessons accumulate instead of evaporating.

---

## When to fire

Right after `cortextos bus complete-task <id>` succeeds. Same session. Do NOT batch — by tomorrow you will not remember the texture of what worked.

## Command

```bash
cortextos bus task-reflect <task-id> \
  --worked "<what worked: technique / collaboration / decision>" \
  --failed "<what fell short: wrong assumption / detour / missing context>" \
  --change "<one concrete change for the next task in this shape>"
```

The CLI appends a block to `memory/$(date -u +%Y-%m-%d).md`:

```
## Task <id> reflection (HH:MM UTC)
- WORKED: ...
- FAILED: ...
- CHANGE: ...
```

It is idempotent per `(agent, date, task-id)` — a second call for the same task on the same day exits 2 and refuses to write. That is intentional: reflect once, deeply, not twice, sloppily.

## What makes a good reflection

| Field | Good | Bad |
| ----- | ---- | --- |
| WORKED | "verify-before-execute caught a false premise about the cron script before I wrote any code — saved ~30 min" | "everything went well" |
| FAILED | "I assumed gitea was reachable from MacBook over tailnet — it isn't (port 3030 timed out); cost 8 min of failed fetch + retry" | "ran into issues" |
| CHANGE | "next cross-machine deploy: format-patch + scp + git am, do not try git fetch across hosts" | "be more careful" |

Concrete > general. Surprising > obvious. Future-you should be able to act on it.

## What if the task was trivial?

Skip. Reflection is for tasks where you learned something. A 2-minute fix that worked exactly as predicted does not need a reflection — it will make the daily file noisy and bury the real lessons.

Rule of thumb: if the work took >10 min OR the result surprised you in any direction, write a reflection.

## What if I have nothing to say for one of the fields?

Write "n/a" rather than fabricating. A "FAILED: n/a" reflection is fine when the task really was clean. But check yourself — usually there is at least one detour worth naming.

## Cross-cutting patterns → MEMORY.md

When the same WORKED/FAILED/CHANGE shows up across 3+ reflections, it is no longer an episode — it is a pattern. Surface it manually to your durable memory under `~/.claude/projects/-Users-subbu-ai-assistant-cortextos-orgs-subbu-ops-agents-<agent>/memory/` as a feedback or reference memory, then add an entry to MEMORY.md. Chief reviews weekly.

## Related

- `.claude/skills/tasks/SKILL.md` — full task lifecycle (create / claim / complete).
- `.claude/skills/error-postmortem/SKILL.md` — sister protocol for failures (Hermes #4).
- `.claude/skills/event-logging/SKILL.md` — `task-reflect` auto-logs a `task_reflection` event for dashboard surfacing.
