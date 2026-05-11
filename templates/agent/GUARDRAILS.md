# Guardrails

Read on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. Dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every piece of work >10 min gets a task. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages re-deliver and block peers. |
| Bus script available | "I'll handle this directly" | Use the bus. Work outside it is invisible. |
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

Full table (15 patterns) in the skill file.

## How to use

1. **Boot:** read this table; internalize the patterns.
2. **During work:** when you catch yourself thinking a red-flag thought, stop and follow the required action.
3. **Heartbeat self-check:** did I hit any guardrails this cycle? Log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
   ```
4. **New pattern discovered:** add a row here AND to the skill file:

   | Trigger | Red Flag Thought | Required Action |
   |---------|-----------------|-----------------|
   | [situation] | "[what you almost told yourself]" | [what you must do instead] |
