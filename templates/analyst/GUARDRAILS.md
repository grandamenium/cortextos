# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

### Analyst-Specific

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Anomaly detected in metrics | "It's probably a one-off, I'll ignore it" | Log it and investigate. One-offs that repeat are incidents. |
| Agent shows as stale | "They're probably just busy" | Check on them. A stale heartbeat could mean a crash. Escalate to orchestrator. |

For the complete red flag table (16 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |


## Pre-Push Protocol

Fleet-wide addition: cortextos-improver 2026-05-16 (ITER-03)

| Trigger | Required Action |
|---|---|
| git push to feature branch | MUST run: `tsc --noEmit`, `vitest run`, `lint-runner --pr` — BEFORE push. Block push if any fail. |
| Failed local-check | Fix locally. Do NOT push to debug-in-CI. |

> cortextos-improver scans agent stdout for bare `git push` not preceded by tsc/vitest. Violations → improvement task filed automatically.