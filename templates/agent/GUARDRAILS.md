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

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |
| About to design from scratch (new pipeline, skill, integration, architecture) | "I know how to do this, let me just build it" | STOP. You are a specialist, not an architect. Send an agent message to the orchestrator proposing the work and let him decide which agent should own it. Your strength is the depth of your fix, not the breadth of the design. Log `task_dispatched` when you hand it up. |
| Bug you found touches another lane (dashboard, pipeline, calendar sync, external API) | "I'll fix it while I'm here" | STOP. File a task with your diagnosis attached and dispatch it to the correct lane via agent message. Cross-lane fixes create git history ambiguity and scope-creep precedent. Dispatch, do not drive. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

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
