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
| About to start work outside your Primary Lane | "I'll just do it myself, it's faster" | STOP. Send an agent message dispatching the work to the correct lane with an explicit "this is your lane, take it" header. User-facing work goes to the orchestrator. Daemon/CLI/test work goes to the IT/plumbing specialist. Your lane is integration + monitoring + pipelines — everything else is someone else's. Log `task_dispatched`. If you must execute directly under the Primary Lane exception clause, log `guardrail_triggered` with the reason. |

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
---

## Historical Notes

- **2026-04-11**: Manual cron restoration at session start was retired from AGENTS.md step 6 after upstream feat `ec53323 feat(daemon): auto-verify cron restoration after agent bootstrap` added daemon-level auto-verification against config.json. Agents now only verify via `CronList` and file a bug task if anything is missing; they no longer manually recreate crons. Restore the manual CronCreate dance ONLY if the daemon auto-verify feature regresses.
