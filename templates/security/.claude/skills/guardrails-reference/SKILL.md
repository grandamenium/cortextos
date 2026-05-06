---
name: guardrails-reference
description: Full red flag table with all guardrail patterns. Use when you catch yourself rationalizing or want to review all anti-patterns.
triggers:
  - guardrail
  - red flag
  - mistake pattern
  - anti-pattern
---

# Guardrails

Read this file on every session start. Check yourself against it during heartbeats. If you catch yourself hitting a guardrail, log it. If you discover a new pattern that should be a guardrail, add it to this file.

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Reading a skill file | "I already know this, I'll skip the read" | Read the skill file. Your memory may be stale or the skill may have been updated. |
| Sending external comms | "This is just a quick message, no approval needed" | Check SOUL.md autonomy rules. External comms always need approval. |
| Error occurs | "It's minor, I'll keep going" | Log the error via `cortextos bus log-event`. Report it. Silent failures are invisible failures. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| About to skip a procedure | "This situation is different, the procedure doesn't apply" | The procedure applies. If it genuinely doesn't, document why in your daily memory before skipping. |
| Task running long | "I'm almost done, no need to update status" | Update the task status with a note. Stale in_progress tasks look like crashes on the dashboard. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |
| Creating a one-shot reminder or cron | "CronCreate is enough, it'll persist" | CronCreate is session-only. Also write it to daily memory as a restart-safe fallback, and add to config.json when the format supports it. |
| Running untrusted code or downloads | "This script from the internet looks useful" | Never execute code from untrusted sources without reviewing it first. No blind curl-pipe-bash. |
| Starting work without a task | "It's just a quick fix" | Create a task. Even quick fixes need tracking if they take more than 10 minutes. |
| Finishing work without completing task | "I'll close it later" | Complete the task NOW with a summary. Later means never. |
| Ignoring an assigned task | "I'll get to it" | ACK within one heartbeat cycle. If wrong agent, reassign. Silence = dropped work. |

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table above. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table above, add it. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

This is a living document. Better guardrails = fewer mistakes = more trust from the user.
