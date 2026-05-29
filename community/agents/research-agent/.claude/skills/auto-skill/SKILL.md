---
name: auto-skill
description: "You just completed a complex task that required 8+ distinct tool calls, or you noticed you are solving the same type of problem for the third time. Create a skill candidate draft so this workflow can be reused in future sessions without rediscovery. Draft goes to skills/drafts/ — never auto-activates until the user approves."
triggers: ["create skill", "draft skill", "skill candidate", "auto-skill", "I've done this before", "skill from task", "save this workflow", "make this a skill", "approve skill", "reject skill", "activate skill"]
---

# Auto-Skill Creation

When you complete a complex task with 8+ tool calls, or recognise a repeating pattern, draft a skill candidate. Drafts stage in `skills/drafts/` until approved — they are never auto-loaded into live sessions.

---

## Step 1: Post-Task Detection Check

After completing any task, run this self-check:

1. **Tool call count**: Did this task require 8+ distinct tool calls for a coherent workflow?
2. **Recurrence**: Does your daily memory show this same task type appearing 3+ times across different dates?
3. **Existing skill**: Does a skill for this already exist in `.claude/skills/`? If yes, stop — consider proposing a patch instead.
4. **Repeatability**: Is this task type likely to recur, or was it a one-off?

If yes to 1 or 2, AND no to 3, AND yes to 4 → create a draft.

**Do NOT draft for:**
- Routine heartbeat operations
- One-off research tasks
- Tasks already covered by existing skills
- Simple single-step operations

---

## Step 2: Draft the Skill

Create the draft at `skills/drafts/[skill-name]/SKILL.md`:

```bash
mkdir -p skills/drafts/[skill-name]
```

Use this template:

```markdown
---
name: skill-name-here
description: One sentence, max 100 chars. What this skill does and when to use it.
created: YYYY-MM-DD
created_by: auto
trigger: "Natural language description of when this skill fires"
source_task_id: TASK-ID-THAT-GENERATED-THIS
version: 1
status: draft
---

## Purpose

[What this skill does. 2-3 sentences max.]

## When to Use

[Specific conditions that should trigger this skill. Be concrete.]

## Inputs Required

- `$PARAM_1` — description
- `$PARAM_2` — description (optional)

## Steps

1. [Step 1 — specific, actionable]
2. [Step 2]
3. ...

## Output

[What gets created or sent when this skill completes.]

## Approval Gate

[Does any step require user approval? Specify exactly which step.]

## Notes / Edge Cases

[Known failure modes, dedup considerations, platform quirks.]
```

---

## Step 3: Self-Review Before Saving

Before writing the file, check:

- [ ] `description` is under 100 characters
- [ ] No skill with this name exists in `.claude/skills/`
- [ ] All steps are actionable — no vague instructions like "handle errors appropriately"
- [ ] Any step requiring external actions (email, deploy, post, delete) has an explicit approval gate documented
- [ ] `source_task_id` is filled in for traceability

If any check fails, revise before saving.

---

## Step 4: Log and Notify

After saving the draft:

```bash
# Log the creation
cortextos bus log-event action skill_draft_created info --meta "{\"skill\":\"[skill-name]\",\"source_task\":\"[task_id]\",\"agent\":\"$CTX_AGENT_NAME\"}"

# Notify orchestrator — it will surface in the next morning digest
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Skill candidate drafted: [skill-name] — source task [task_id]. Check skills/drafts/[skill-name]/SKILL.md. Awaiting digest review."
```

The orchestrator includes it in the next morning briefing for the user. The user replies `approve [skill-name]`, `reject [skill-name] [reason]`, or `revise [skill-name] [feedback]`.

---

## Step 5: Handling Approval Responses

When you receive an inbox message with a skill decision:

### Approved

```bash
# Move from draft to active
mv skills/drafts/[skill-name]/ .claude/skills/[skill-name]/

# Update status field
sed -i '' 's/status: draft/status: active/' .claude/skills/[skill-name]/SKILL.md

# Log activation
cortextos bus log-event action skill_activated info --meta "{\"skill\":\"[skill-name]\",\"agent\":\"$CTX_AGENT_NAME\"}"

# Notify the user
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Skill activated: [skill-name] is now live and will be used in future sessions."

# ACK the inbox message
cortextos bus ack-inbox [msg_id]
```

### Rejected

```bash
# Move to archive with reason recorded
mkdir -p skills/archive/[skill-name]
mv skills/drafts/[skill-name]/SKILL.md skills/archive/[skill-name]/SKILL.md

# Append rejection reason to archived skill
echo "\n## Rejection\nReason: [reason]\nDate: $(date -u +%Y-%m-%d)" >> skills/archive/[skill-name]/SKILL.md

# Log
cortextos bus log-event action skill_rejected info --meta "{\"skill\":\"[skill-name]\",\"reason\":\"[reason]\"}"

cortextos bus ack-inbox [msg_id]
```

### Revise

```bash
# Apply feedback and re-save the draft
# Then re-notify orchestrator for another digest cycle
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Skill candidate [skill-name] revised per feedback. Ready for re-review."
cortextos bus ack-inbox [msg_id]
```

---

## Draft Lifecycle

| State | Location | Loaded at boot? |
|-------|----------|-----------------|
| draft | `skills/drafts/[name]/SKILL.md` | No |
| active | `.claude/skills/[name]/SKILL.md` | Yes |
| archived | `skills/archive/[name]/SKILL.md` | No |

Drafts older than 14 days with no action: move to `skills/archive/` and log `skill_expired`.

---

## Critical Rules

1. **No automated commits** — skill files are never committed without explicit user approval
2. **Draft means invisible** — agents do NOT load or execute skills from `skills/drafts/`
3. **No self-modification** — skills never modify other skills (v2 feature)
4. **No external calls without gates** — any skill step with external side effects must document its own approval requirement
