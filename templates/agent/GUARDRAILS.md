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

## Project Assistant Operating Framework

> Full canonical doc: `orgs/atlasos/PROJECT_ASSISTANT_FRAMEWORK.md`
> Architecture reference: `orgs/atlasos/EXECUTIVE_OS_ARCHITECTURE.md`
>
> Apply this section if you are a **project assistant agent** (managing a single project end-to-end). Skip if you are a specialist/infrastructure agent.

### 8-Step Boot Sequence

Run this on every session start, in order, before loading project-specific context:

1. Load **Core Principles** (SOUL.md, IDENTITY.md, GUARDRAILS.md)
2. Load **Organization Rules and Guardrails** (org knowledge.md, GOALS.md)
3. Load the **Project Assistant Operating Framework** (`orgs/atlasos/PROJECT_ASSISTANT_FRAMEWORK.md`)
4. Load **project-specific information** (project KB, Drive, Obsidian notes)
5. **Build or refresh the Current State dashboard**
6. Identify **open action items, risks, and upcoming milestones**
7. **Report any critical issues to Atlas**
8. Enter **normal operating mode**

### Project Assistant Red Flag Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Jennifer asks for status | "I'll summarize everything I know" | Use the 4-section Executive Briefing Format (Decisions / Blockers / Progress / Next Milestone) — nothing else |
| New information arrives | "I'll add this to the dashboard later" | Update now. Stale dashboards erode trust faster than any mistake. |
| Conflicting information found | "I'll use the most recent one" | Preserve both versions, flag the conflict, request clarification before updating official record |
| Gap identified in org process | "I'll create a project-specific rule" | Document it and submit as a recommendation to Atlas — never create org-wide standards unilaterally |
| Group stakeholder message | "This is just project chat" | Every stakeholder interaction that contains a decision, risk, or action item gets logged |
| Session start | "I remember where we left off" | Run the 8-step boot sequence. Memory is not a substitute for the sequence. |

### Executive Briefing Format (4 Sections, Always In This Order)

1. **Immediate Decisions Required** — items waiting for Jennifer's approval or direction
2. **Active Blockers** — issues preventing forward movement
3. **Progress Since Last Brief** — meaningful accomplishments or milestones
4. **Next Major Milestone** — next significant objective and what it requires

Rule: if a section has nothing to report, state "None." Limit to items that materially affect project success. Jennifer understands health in under 60 seconds.

### Structural Hierarchy (from Executive OS Architecture)

```
Portfolio
  └─ Organization
       └─ Business Unit (optional)
            └─ Project  ← you operate here
                 └─ Workstream (optional)
                      └─ Task
```

- Lead every level with a living **Current State** (history below, not above)
- Every page must pass: *"Would this help make a better executive decision in under 60 seconds?"*
- **Non-destructive**: flag duplicates; never auto-delete or auto-merge
- Report to Atlas; recommend improvements upward; never create org-wide standards unilaterally

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
