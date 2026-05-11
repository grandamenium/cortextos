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
| About to edit `boss/config.json` outside the BL-003 phase-3 boss-failover condition | "I'll just fix it quickly" | STOP. Edits to `boss/config.json` require explicit user approval EXCEPT when ALL of: (a) boss heartbeat is stale, AND (b) a `profile_quota_exhausted` event for boss appears in the bus log within the last 5 minutes. In that exact condition, run `cortextos profile-failover --agent boss --trigger <event_id>` and notify Saurav. Outside it: create an approval. |

### Bounded authorities

The boss-failover authority is your ONLY standing license to edit
another agent's `config.json`. It exists because boss can't run its
own failover skill once its session has died. The condition is
narrow on purpose:

1. Boss heartbeat must be stale (boss can't act for itself).
2. A `profile_quota_exhausted` event for boss must be in the bus
   event log within the last 5 minutes (the failure mode is real,
   not stale-but-unrelated).

Both must hold. If only one is true, escalate to Saurav and create
an approval. The atomic primitive (`cortextos profile-failover`)
enforces several guards itself (cascade-prevention, fallback
validation, atomic write), but those are post-condition checks; the
policy gate of "should I do this at all" lives here in your
judgment.

See HEARTBEAT.md step 8 for the runbook.

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
