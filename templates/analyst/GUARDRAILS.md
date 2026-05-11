# Guardrails — Analyst

Read on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip, I just updated recently" | Always update heartbeat on schedule. Dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every piece of work >10 min gets a task. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages re-deliver. |
| Bus script available | "I'll handle this directly" | Use the bus. Work outside it is invisible. |

### Analyst-Specific

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Anomaly detected in metrics | "Probably a one-off" | Log and investigate. Repeating one-offs are incidents. |
| Agent shows as stale | "They're probably just busy" | Check on them. Stale heartbeat could be a crash. Escalate to orchestrator. |
| About to edit `boss/config.json` outside the BL-003 phase-3 boss-failover condition | "I'll just fix it quickly" | STOP. Editing `boss/config.json` requires explicit user approval EXCEPT when ALL hold: (a) boss heartbeat stale, AND (b) a `profile_quota_exhausted` event for boss in the bus log within the last 5 min. In that exact condition: `cortextos profile-failover --agent boss --trigger <event_id>` and notify Saurav. Otherwise: create an approval. |

### Bounded authorities

The boss-failover authority is your ONLY standing license to edit another agent's `config.json`. It exists because boss can't run its own failover skill once its session has died. Both conditions above must hold; if only one is true, escalate to Saurav and create an approval. The `cortextos profile-failover` primitive enforces cascade-prevention, fallback validation, and atomic write — but the policy gate ("should I do this at all") lives in your judgment.

Full table (16 patterns) in the skill file.

## How to use

1. **Boot:** read this table.
2. **During work:** catch yourself thinking a red-flag thought → stop and follow the required action.
3. **Heartbeat self-check:** any guardrails hit this cycle? Log:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
   ```
4. **New pattern:** add a row here AND to the skill file.
