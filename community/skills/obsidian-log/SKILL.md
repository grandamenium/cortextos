---
name: obsidian-log
effort: low
description: "Write key decisions, project milestones, and feedback rules back to the Obsidian vault. Use this after confirming any architectural decision, project milestone, or durable feedback rule — keeps the vault current with agent memory."
triggers: ["obsidian", "write to vault", "log decision", "save to obsidian", "update vault", "obsidian log", "decision log", "vault write-back", "milestone logged", "write back", "obsidian write"]
---

# Obsidian Log Skill

> Write agent decisions and milestones back to the Obsidian vault so it stays current with agent memory. Use after confirming any significant decision, project milestone, or durable feedback rule.

---

## When to Use

Trigger this skill when you:
- Confirm an architectural or product decision (e.g. "we decided X approach for Y")
- Complete a project milestone and want it recorded (e.g. "feature Z shipped")
- Receive and confirm a durable feedback rule (e.g. "always do X, never do Y")
- Finish an onboarding or knowledge distillation session

Do NOT log every task or message — only decisions and milestones that should persist across agents and sessions.

---

## CLI Reference

The Obsidian CLI writes directly to vault notes. Replace `[VAULT_NAME]` with your configured vault name.

### Create or overwrite a note
```bash
obsidian vault=[VAULT_NAME] create path="<note-path>" content="<content>" overwrite
```

### Append to an existing note
```bash
obsidian vault=[VAULT_NAME] append path="<note-path>" content="<content>"
```

---

## Workflow

### 1. Log a decision (daily decisions log)

Decisions go to `01-Memory/decisions-YYYY-MM-DD.md`. Append so the daily file accumulates entries:

```bash
TODAY=$(date +%Y-%m-%d)
obsidian vault=[VAULT_NAME] append \
  path="01-Memory/decisions-${TODAY}.md" \
  content="
## [HH:MM] <Decision title>

**Decision:** <What was decided>
**Why:** <Reasoning or constraint that drove it>
**Impact:** <What changes as a result>
**Agent:** [AGENT_NAME]
"
```

If the daily file does not exist yet, use `create` instead of `append`:

```bash
TODAY=$(date +%Y-%m-%d)
obsidian vault=[VAULT_NAME] create \
  path="01-Memory/decisions-${TODAY}.md" \
  content="# Decisions — ${TODAY}

## [HH:MM] <Decision title>

**Decision:** <What was decided>
**Why:** <Reasoning or constraint that drove it>
**Impact:** <What changes as a result>
**Agent:** [AGENT_NAME]
" overwrite
```

### 2. Log a project milestone

Project milestones append to `02-Projects/<project-name>.md`:

```bash
obsidian vault=[VAULT_NAME] append \
  path="02-Projects/<project-name>.md" \
  content="
## Milestone — $(date +%Y-%m-%d)

**What shipped:** <Feature or deliverable>
**Status:** Complete
**Notes:** <Any relevant context>
"
```

### 3. Log a durable feedback rule

Feedback rules that should persist append to `01-Memory/agent-feedback.md`:

```bash
obsidian vault=[VAULT_NAME] append \
  path="01-Memory/agent-feedback.md" \
  content="
## $(date +%Y-%m-%d) — <Rule title>

**Rule:** <The feedback rule>
**Why:** <Reason given by user or inferred>
**Agent:** [AGENT_NAME]
"
```

---

## Keep the KB Current

After writing to the vault, ingest the updated memory folder so agents can find it via KB search:

```bash
cortextos bus kb-ingest <vault-path>/01-Memory --org [ORG] --scope shared
```

You can also add a daily cron entry to `config.json` to keep the KB automatically current:

```json
{
  "name": "daily-memory-kb-ingest",
  "cron": "0 4 * * *",
  "prompt": "Ingest today's memory files into the KB: cortextos bus kb-ingest <vault-path>/01-Memory --org [ORG] --scope shared. Log the result.",
  "type": "recurring"
}
```

---

## Checklist Before Writing

- [ ] Is this a decision, milestone, or feedback rule — not just a task update?
- [ ] Does the vault path match the correct date / project name?
- [ ] Use `append` if the file exists, `create` with `overwrite` if starting fresh for the day
- [ ] Ingest `01-Memory/` after writing so the KB reflects the new entry

---

*Deployment note: replace `[VAULT_NAME]`, `[AGENT_NAME]`, and `[ORG]` with your actual values. Add the vault path to your agent's TOOLS.md so it is available at session start.*
