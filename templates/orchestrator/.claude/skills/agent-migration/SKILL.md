# Agent Migration Skill

> Port any existing agent workspace — cortextOS legacy, custom Claude setup, or any other agent system — into a cortextOS v2 agent. This skill is for the orchestrator. Run it when the user wants to bring an existing agent into the system.

---

## Core Principle

**Knowledge transfers. Behavior does not.**

Extract durable facts, user preferences, domain expertise, skills, and documents from the old workspace. Write fresh v2 bootstrap files informed by that data. Do NOT copy-paste files wholesale — rewrite them in clean v2 format.

---

## Phase 1: Audit the Source Workspace

Before touching anything, read and catalog what exists.

### 1a. Identify source location

```bash
SOURCE_DIR="<path to old agent workspace>"
ls "$SOURCE_DIR"
ls "$SOURCE_DIR/.claude/skills/" 2>/dev/null || ls "$SOURCE_DIR/skills/" 2>/dev/null
ls "$SOURCE_DIR/docs/" 2>/dev/null
ls "$SOURCE_DIR/memory/" 2>/dev/null
```

### 1b. Catalog by category

Read each file type and note what exists:

| Category | Files to check | Port decision |
|----------|---------------|---------------|
| Bootstrap | IDENTITY.md, SOUL.md, MEMORY.md, GUARDRAILS.md, USER.md, GOALS.md, SYSTEM.md, TOOLS.md | Extract + rewrite |
| Skills | .claude/skills/* or skills/* | Copy to .claude/skills/ |
| CRM / contacts | crm/, contacts.json | Copy to crm/ |
| Meetings / notes | meetings/, briefs/ | Copy preserving structure |
| Documents / research | Any .md docs, outputs | Copy to docs/ with topic subfolders |
| Config | config.json | Extract crons + approval rules |
| Secrets / .env | .env | DO NOT copy — source fresh from user |

### 1c. Present audit to user

Tell the user what you found in each category and ask for confirmation before proceeding:
> "Here's what [agent name] has and what I'd recommend porting: [breakdown by category]. Anything to add or remove?"

---

## Phase 2: Create the New Agent

```bash
cd "$CTX_FRAMEWORK_ROOT"
cortextos add-agent <new_name> --template agent --org $CTX_ORG
```

Get a Telegram bot token from the user (they must create via @BotFather). Get chat ID via getUpdates after user sends /start + any message.

```bash
cat > "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/.env" << EOF
BOT_TOKEN=<token>
CHAT_ID=<chat_id>
ALLOWED_USER=<user_id>
EOF
chmod 600 "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/.env"
```

**Do NOT start the agent yet** — pre-load files first.

---

## Phase 3: Extract Knowledge (Read Before Writing)

Read these source files carefully before writing anything:

### MEMORY.md → extract durable facts

Read the entire file. For each entry ask: *Is this still true about the world? Or is it a patch for an old system bug?*

**Keep:** User preferences, business facts, workflow rules the user set, contact info, system account details, discovered patterns that are genuinely useful.

**Discard:** Entries referencing old file paths, old bus scripts, old system internals, session-specific state, error workarounds.

Rewrite kept entries as clean bullet points in the new agent's MEMORY.md.

### GUARDRAILS.md → selective port

Read each row. For each ask: *Did the user set this rule, or did the agent add it because of a system bug?*

**Keep:** Rows that encode the user's explicit preferences (e.g. "always approval before external comms", "never email customers without approval").

**Discard:** Rows that reference old bus scripts, old file paths, or are clearly bug-workarounds (e.g. "always use X script instead of Y because Y crashes").

Add kept rows to the new agent's GUARDRAILS.md domain section.

### USER.md → port fully

This is pure knowledge about the user. Port all of it. Rewrite in v2 USER.md format. Remove any section that references old system internals or stale state.

### IDENTITY.md → port role, vibe, work style

Extract: name, role, emoji, vibe, work style bullets. Rewrite in v2 IDENTITY.md format. Update any references from old orchestrator name to new orchestrator name (e.g. boss → boss2).

### SOUL.md → write fresh, inform with old

Do NOT copy the old SOUL.md. The v2 SOUL.md template is better. Only extract:
- Day/night mode hours (if explicitly set by user)
- Any autonomy rules the user explicitly configured

Write these into the new v2 SOUL.md.

### config.json → extract crons

Read the old crons array. Port crons that represent user-defined schedules (inbox triage intervals, calendar checks, etc.). Update skill paths from `skills/` to `.claude/skills/`. Do NOT port crons that reference old bus scripts by path.

---

## Phase 4: Copy Files

### Skills

```bash
SOURCE_SKILLS="$SOURCE_DIR/skills"  # or .claude/skills
DEST_SKILLS="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/.claude/skills"

# Copy each domain skill (not standard v2 skills already in template)
for skill in email-management calendar-management flight-booking contacts-management \
             google-workspace imessage phone-calls travel-prep meeting-prep \
             meeting-recording peekaboo-automation comms-drafting; do
  [ -d "$SOURCE_SKILLS/$skill" ] && cp -r "$SOURCE_SKILLS/$skill" "$DEST_SKILLS/"
done
```

Standard v2 skills (tasks, comms, heartbeat, cron-management, etc.) are already in the template — do not overwrite them with old versions.

### CRM

```bash
DEST="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/crm"
mkdir -p "$DEST"
cp "$SOURCE_DIR/crm/contacts.json" "$DEST/" 2>/dev/null
cp "$SOURCE_DIR/crm/"*.sh "$DEST/" 2>/dev/null
cp "$SOURCE_DIR/crm/README.md" "$DEST/" 2>/dev/null
```

### Meetings

```bash
cp -r "$SOURCE_DIR/meetings" \
  "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/"
```

Preserve the existing category structure (e.g. business/, personal/, etc.).

### Documents

```bash
DEST_DOCS="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/docs"
# Create topic subfolders based on what exists
mkdir -p "$DEST_DOCS/band" "$DEST_DOCS/ios" "$DEST_DOCS/product"
# Copy by topic — review each file to determine correct subfolder
```

Rule: one subfolder per distinct topic. If unsure, ask the user. Do not dump everything into docs/ root.

---

## Phase 5: Write Bootstrap Files

Write each file fresh. Do not copy-paste from source. Rewrite using extracted knowledge.

### goals.json

```bash
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/goals.json" << EOF
{
  "focus": "<agent's core purpose, one sentence>",
  "goals": [
    "<standing goal 1>",
    "<standing goal 2>",
    "<standing goal 3>"
  ],
  "bottleneck": "",
  "updated_at": "$TIMESTAMP",
  "updated_by": "$CTX_AGENT_NAME"
}
EOF
cortextos goals generate-md --agent <new_name> --org $CTX_ORG
```

### SOUL.md

Update the day/night placeholders and any autonomy rules:

```bash
# Update day/night mode in SOUL.md
sed -i '' 's/{{day_mode_start}}/<HH:MM>/g' \
  "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/SOUL.md"
sed -i '' 's/{{day_mode_end}}/<HH:MM>/g' \
  "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>/SOUL.md"
```

---

## Phase 6: KB Ingestion

After all files are copied:

```bash
cd "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<new_name>"

# Shared org knowledge (meetings, research, docs)
cortextos bus kb-ingest ./meetings --org $CTX_ORG --scope shared
cortextos bus kb-ingest ./docs --org $CTX_ORG --scope shared

# Private agent knowledge (CRM, personal memory)
cortextos bus kb-ingest ./MEMORY.md ./crm/contacts.json \
  --org $CTX_ORG --agent <new_name> --scope private
```

---

## Phase 7: Boot + Onboarding

```bash
cd "$CTX_FRAMEWORK_ROOT" && cortextos start <new_name>
```

Send a workspace orientation message via the bus. This is the first message the agent will receive. It must instruct the agent to read the entire migrated workspace before doing anything else — including before contacting the user — and then run a migration-aware onboarding:

```bash
cortextos bus send-message <new_name> normal \
  'You have been migrated from a legacy agent workspace into cortextOS v2. Before doing anything else — before messaging the user, before setting up crons, before running onboarding — read your entire workspace:

1. Bootstrap files: IDENTITY.md, SOUL.md, MEMORY.md, USER.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md
2. All files in .claude/skills/ — understand what each skill does
3. All files in docs/ — understand what knowledge has been ported
4. Any additional folders (crm/, meetings/, scripts/, etc.)

Once you have read everything, send the user a Telegram message confirming what you found: your role, what skills you have, what docs are loaded, and any gaps or missing credentials you noticed.

Then proceed with cortextOS onboarding (/onboarding), but treat it as a migration-aware onboarding: skip or fast-track any steps that are already handled by the pre-loaded files (identity, role, voice, goals). Focus onboarding on: tool access verification, API key setup, cron confirmation, and any gaps specific to your domain.'
```

Log the dispatch:

```bash
cortextos bus log-event action task_dispatched info \
  --meta '{"to":"<new_name>","task":"workspace orientation + migration-aware onboarding"}'
```

Update SYSTEM.md team roster:

```bash
# Add to SYSTEM.md ## Team Roster section:
# - **<new_name>**: <role>
```

---

## Decision Reference: What to Port

| Item | Port? | How |
|------|-------|-----|
| MEMORY.md facts | Selectively | Extract durable facts, rewrite clean |
| GUARDRAILS.md rows | Selectively | Keep user-set rules, discard bug patches |
| USER.md | Yes (fully) | Rewrite in v2 format |
| IDENTITY.md | Yes (role/vibe/style) | Rewrite in v2 format |
| SOUL.md | No — write fresh | Only extract day/night hours + explicit autonomy rules |
| TOOLS.md | No — use v2 template | Template is better |
| Domain skills (.claude/skills/) | Yes | Copy directly |
| CRM / contacts | Yes | Copy directly |
| Meetings / briefs | Yes | Copy, preserve structure |
| Documents / research | Yes | Copy, organize into docs/topic/ subfolders |
| config.json crons | Selectively | Port user-defined schedules, update paths |
| .env (tokens/secrets) | Never | Source fresh from user |
| Daily memory files | No | These are session logs — discard |
| Old bus script references | Never | Update all paths to v2 cortextos bus commands |

---

## Notes

- Always present the audit to the user before executing — confirm what to include/exclude
- If the source uses old bash bus scripts (`bus/send-message.sh`, etc.), translate all commands to `cortextos bus <command>` equivalents
- If the source workspace has custom tools or MCP configs, check with user whether to port them
- The permission-prompt issue (agent getting stuck at file edit approval dialog) is fixed in v2 via pre-approved .claude settings — verify the new agent's .claude/settings.json allows edits


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
