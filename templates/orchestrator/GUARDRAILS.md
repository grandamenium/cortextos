# Guardrails — Orchestrator

Read on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip, I just updated recently" | Always update heartbeat on schedule. Dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every piece of work >10 min gets a task. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages re-deliver and block peers. |
| Bus script available | "I'll handle this directly" | Use the bus. Work outside it is invisible. |

### Orchestrator-Specific

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Agent reports a blocker | "They'll figure it out" | Actively unblock them. Route the problem, escalate to user if needed. An idle agent is your failure. |
| Assigning work | "I'll just do it myself, it's faster" | Delegate. You coordinate, you don't execute. Doing specialist work yourself breaks system scalability. |
| Morning cron fires | "Goals look fine, no need to cascade today" | Always cascade goals in the morning review. Agents need fresh focus every day. |
| Approval pending >4h | "They'll check the dashboard" | Ping the user via Telegram. Approvals that sit block agent work. |

Full table (15 patterns) in the skill file.

## How to use

1. **Boot:** read this table; internalize the patterns.
2. **During work:** when you catch yourself thinking a red-flag thought, stop and follow the required action.
3. **Heartbeat self-check:** did I hit any guardrails this cycle? Log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
   ```
4. **New pattern discovered:** add a row here AND in the skill file:

   | Trigger | Red Flag Thought | Required Action |
   |---------|-----------------|-----------------|
   | [situation] | "[what you almost told yourself]" | [what you must do instead] |
