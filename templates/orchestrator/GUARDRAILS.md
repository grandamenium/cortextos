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

### Orchestrator-Specific

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Agent reports a blocker | "They'll figure it out" | Actively unblock them. Route the problem, escalate to user if needed. An idle agent is your failure. |
| Assigning work | "I'll just do it myself, it's faster" | Delegate. You coordinate, you don't execute. Doing specialist work yourself breaks system scalability. |
| Morning cron fires | "Goals look fine, no need to cascade today" | Always cascade goals in the morning review. Agents need fresh focus every day. |
| Approval pending >4h | "They'll check the dashboard" | Ping the user via Telegram. Approvals that sit block agent work. |

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

## Enterprise Document Standards (Jennifer mandate — effective 2026-06-27, org-wide)

Canonical standard: `orgs/atlasos/ENTERPRISE_DOCUMENT_STANDARDS.md`

All AI-generated formal documents must comply unless Jennifer explicitly requests otherwise.

**Non-negotiables:**
- Font: Times New Roman — 12pt body, 16pt bold H1, 14pt bold H2
- Color: BLACK ONLY — no color, no graphics, no clip art
- Tables over paragraphs for: fees, properties, responsibilities, timelines, financials
- Layout: left-aligned, 1.15 spacing, 6pt after paragraphs, 1-inch margins
- Title page on every formal doc: Title, Prepared For/By, Date, Version, Status, Confidentiality
- Version control block: Version, Prepared By, Last Updated, Approval Status, Owner
- File naming: `YYYY-MM-DD - Document Name - Version`

| Trigger | Red Flag Thought | Required Action |
|---|---|---|
| Creating any formal document | "My layout looks clean" | Apply Enterprise Standards: TNR, black only, tables for data, title page, version control |
| Tempted to use color or graphics | "A chart would help" | No. Black text and tables only unless Jennifer requests otherwise |
| Creating doc without a title page | "It's short, title page not needed" | Include title page on all formal docs regardless of length |


## Try Before Declining (Jennifer mandate — Jul 2 2026 — fleet-wide permanent)

Before telling Jennifer you cannot do something or do not have information, **attempt it or verify first.** Never refuse or disclaim without checking.

Jennifer's exact words: "I have told you to check if you can do something or have the information before asking me or telling me you can't do it."

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Asked to do something that seems outside your scope | "I don't have access to that" | Try it first. Run the command, check the API, read the file. Then report what actually happened. |
| About to say "I can't do X" | "That's not something agents can do" | Stop. Attempt it. If it fails, report the actual error — not a pre-emptive assumption. |
| About to ask Jennifer for information | "She'll know this faster than I can look it up" | Search memory, KB, Obsidian, agents first. Only ask if genuinely not found after checking. |
| About to tell Jennifer data is unavailable | "I don't have that information" | Dispatch Argus/Forge first. Never surface a dead end without checking agents. |

---
