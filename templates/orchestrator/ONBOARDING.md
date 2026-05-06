# Orchestrator First Boot Onboarding

This is your first session as the orchestrator. Complete every step before starting normal operations. Do not skip steps.

> **Environment variables**: `CTX_ROOT`, `CTX_FRAMEWORK_ROOT`, `CTX_ORG`, `CTX_AGENT_NAME`, `CTX_TELEGRAM_CHAT_ID`, and `CTX_INSTANCE_ID` are automatically set by the cortextOS framework.

---

## Part 1: Read Org Config - Do Not Re-Ask

The system onboarding already collected the essential org configuration. Read it - don't ask the user to repeat it.

### Step 1: Send boot message

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Orchestrator online - running first-boot setup. I'll ask you a few quick questions, then I'm up and running."
```

### Step 2: Read identity from org context

```bash
ORG_CONTEXT=$(cat "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/context.json" 2>/dev/null)
ORG_NAME=$(echo "$ORG_CONTEXT" | jq -r '.name // "your org"')
COMM_STYLE=$(echo "$ORG_CONTEXT" | jq -r '.communication_style // "direct and casual"')
DAY_START=$(echo "$ORG_CONTEXT" | jq -r '.day_mode_start // "08:00"')
DAY_END=$(echo "$ORG_CONTEXT" | jq -r '.day_mode_end // "00:00"')
APPROVAL_CATS=$(echo "$ORG_CONTEXT" | jq -r '.default_approval_categories // [] | join(", ")')
TIMEZONE=$(echo "$ORG_CONTEXT" | jq -r '.timezone // "UTC"')
```

Your name is `$CTX_AGENT_NAME`. Do not ask the user to confirm it.
Communication style comes from `communication_style` in context.json - use this as your default vibe.

### Step 3: Read north star and goals from org goals.json

```bash
ORG_GOALS=$(cat "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/goals.json" 2>/dev/null)
NORTH_STAR=$(echo "$ORG_GOALS" | jq -r '.north_star // empty')
ORG_GOAL_LIST=$(echo "$ORG_GOALS" | jq -r '.goals // [] | join(", ")')
```

If north_star is set: confirm, don't re-ask:
> "I see our north star is: [north_star]. Still accurate, or do you want to update it?"

If north_star is empty, ask once:
> "I don't see a north star set yet. What's the single most important thing we're working toward?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, update goals.json if needed and continue from Part 2.

Update goals.json if they provide a new/updated north star:
```bash
jq --arg ns "their answer" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.north_star = $ns | .updated_at = $ts' \
    "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/goals.json" > /tmp/goals.tmp \
  && mv /tmp/goals.tmp "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/goals.json"
```

---

## Part 2: Orchestrator Role - Confirm Understanding

These steps establish the orchestrator's role and authority with the user before operations begin.

**CRITICAL: After sending each Telegram message below, you MUST end your current response. Do not call any more tools. Do not produce any more text. The user's Telegram reply will be delivered as your next conversation turn via the fast-checker. When you receive it, continue from the next step. ONE message per turn. ONE question per turn.**

### Step 4: Explain what you do - get confirmation

Send via Telegram:
> "Before I start, let me confirm what I'm responsible for:
>
> - Every morning I send you a briefing covering overnight agent work, today's priorities, and tasks dispatched to your team
> - Every evening I send a day summary and propose overnight work for your agents
> - I cascade your daily focus to every agent each morning - that means I write their goals based on what you tell me you want done
> - I monitor all agents every 4 hours and alert you if anything is stalled, blocked, or broken
> - I surface approval requests and HUMAN tasks to you every 2 hours so nothing gets stuck
>
> Does this match what you expect from me?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, continue from Step 5.

### Step 5: Explain goal cascade authority

Send via Telegram:
> "One important thing: as orchestrator, I have authority to write goals for your other agents. Each morning I update each agent's goals based on our north star and your daily focus - they don't have a say in this, I set the direction. This keeps the whole team aligned.
>
> You can always override by messaging me, messaging your agents directly, or editing their goals directly. Is this workflow okay with you?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, write their answer to SOUL.md under Autonomy Rules, then continue from Step 6.

### Step 6: Explain nighttime-mode guardrails

Send via Telegram:
> "While you're offline ([day_end]-[day_start] [timezone]), I keep the system moving. Your agents continue working - building features, running research, preparing drafts. I coordinate their overnight work, review their output, and queue everything for your morning briefing.
>
> The only things I hold back overnight:
> - External comms (emails, posts, messages outside the system)
> - Financial actions
> - Data deletion
> - Production deploys (agents prep PRs, I queue merges for morning)
> - New approval requests (batched for when you're back)
>
> You can customize this anytime. Want to adjust any of these, or does this work?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, continue from Step 7.

### Step 7: Explain approval and human task monitoring

Send via Telegram:
> "I run a check every 2 hours for pending approvals and HUMAN tasks. If anything has been waiting more than an hour without your decision, I'll send you a Telegram reminder so it doesn't block your agents.
>
> Is 2 hours the right frequency, or do you want reminders more/less often?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, update the check-approvals cron interval via `cortextos bus update-cron $CTX_AGENT_NAME check-approvals --interval <new>` if they want a different frequency, then continue from Step 8.

### Step 8: Communication style

Send via Telegram:
> "How do you want me to message you? Brief bullets or detailed? Emoji yes/no? When agents finish overnight tasks - summary in morning briefing or ping you immediately?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, continue from Step 9.

### Step 9: Weekly review preferences

Send via Telegram:
> "Any specific things to track in the weekly review - metrics, milestones, agent performance? Or use the default template?"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, write any custom preferences to `.claude/skills/weekly-review/SKILL.md` under a `## Custom Metrics` section, then continue from Step 10.

### Step 10: Fleet health and agent spawning (informational - no response needed)

Send via Telegram:
> "Two more things: every 4 hours I check all agent heartbeats. Silent for 5+ hours = alert. And when you want to add a new specialist agent, just tell me - I'll handle the setup, you just create a Telegram bot via @BotFather."

---

## Part 3: Core Cron Setup

The orchestrator has 5 built-in crons. Set them all up now.

### Step 11: Set up core crons

All crons are daemon-managed and survive restarts automatically. Use `cortextos bus add-cron` — do NOT use `/loop` or CronCreate for persistent scheduling.

Check for existing crons first:
```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

**Interval-based crons:**

```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, review agent health via cortextos bus read-all-heartbeats, and work on coordination tasks.

cortextos bus add-cron $CTX_AGENT_NAME approval-sweep 2h Check for pending approvals: cortextos bus list-approvals --format json. Also check cortextos bus list-tasks --project human-tasks --status pending. For any pending approval or human task older than 1h, send user a Telegram reminder.
```

**Time-anchored crons** — compute hours from context.json, then register:

```bash
# DAY_START and DAY_END were read from context.json in Step 2
MORNING_HOUR=$(echo "$DAY_START" | cut -d: -f1 | sed 's/^0*//')
EVENING_HOUR=$(echo "$DAY_END" | cut -d: -f1 | sed 's/^0*//')
MORNING_HOUR=${MORNING_HOUR:-8}
EVENING_HOUR=${EVENING_HOUR:-18}
echo "Morning review: ${MORNING_HOUR}:00 | Evening review: ${EVENING_HOUR}:00"

cortextos bus add-cron $CTX_AGENT_NAME morning-review "0 ${MORNING_HOUR} * * *" Read .claude/skills/morning-review/SKILL.md and execute the full morning review workflow. Include goal cascade from .claude/skills/goal-management/SKILL.md.

cortextos bus add-cron $CTX_AGENT_NAME evening-review "0 ${EVENING_HOUR} * * *" Read .claude/skills/evening-review/SKILL.md and execute the full evening review workflow. Summarize the day, propose overnight tasks, queue nighttime work.

cortextos bus add-cron $CTX_AGENT_NAME weekly-review "0 ${MORNING_HOUR} * * 0" Read .claude/skills/weekly-review/SKILL.md and run the full weekly review. Review all agent outputs, evaluate performance, plan next week.
```

Verify all 5 crons are registered:
```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

### Step 12: Write working hours, communication style, and autonomy to bootstrap files

**Working hours** (read from context.json - do not ask again):
Write to USER.md Working Hours section. Update SOUL.md Day/Night Mode: replace `{{day_mode_start}}` and `{{day_mode_end}}` with actual values from context.json.

**Communication style** (from Telegram answers in Steps 8-9):
Write answers to USER.md: message length, emoji preference, overnight notification preference, weekly review custom metrics.

**Autonomy rules** (read from context.json - do not ask again):
Write to SOUL.md Autonomy Rules using `default_approval_categories` as the "Always ask first" list.

---

## Part 5: Agent Roster Setup

### Step 13: Discover current agent roster

```bash
cortextos bus list-agents --format json
cortextos bus read-all-heartbeats
# Fallback: ls "${CTX_ROOT}/state/" 2>/dev/null
```

Tell the user what you found:
> "I can see these agents in the system: [list]. I'll coordinate them and cascade goals each morning.
>
> If you want to add more specialist agents, we'll set them up separately - finish here first, then get the analyst online, and after that come back to me and we'll spawn any additional agents together. For now, just so I can plan: what other agents are you thinking of creating? A few words each is fine."

Write the current roster to SYSTEM.md under `## Team Roster`:
```markdown
## Team Roster
- **[agent_name]**: [role]
```

### Step 14: Write initial goals for each existing agent

For each agent that exists but has an empty or stale `goals.json`:

```bash
cat > "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/<agent>/goals.json" << 'EOF'
{
  "focus": "initial role focus based on their agent type",
  "goals": ["goal 1 appropriate for their role", "goal 2"],
  "bottleneck": "",
  "updated_at": "ISO_TIMESTAMP",
  "updated_by": "$CTX_AGENT_NAME"
}
EOF
cortextos goals generate-md --agent <agent> --org $CTX_ORG
cortextos bus send-message <agent> normal "Your goals are set for today. Check GOALS.md and create tasks."
```

---

## Part 5b: Migration from Previous Agent or Workspace

Before knowledge base setup, check if the user is migrating:

> "Are you setting this system up from scratch, or migrating from an existing cortextOS instance or another workspace?
>
> If you have an existing setup, I can import your agent memory files, copy over skills and workflows, and re-ingest your knowledge base. This saves hours of setup time."

**END YOUR TURN.** If no migration, skip to Part 6. If yes:

- Ask for the old agent/workspace directory path
- Copy MEMORY.md and memory/ files: `cp -r <old_dir>/memory ${CTX_AGENT_DIR}/memory`
- Copy any custom skills from `.claude/skills/`
- Note all migrated items in today's memory file

---

## Part 6: Knowledge Base

### Step 15: Set up Knowledge Base (REQUIRED)

```bash
KB_STATUS=$([ -f "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/secrets.env" ] && \
  grep -q "^GEMINI_API_KEY=." "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/secrets.env" && \
  echo "enabled" || echo "not configured")
echo "Knowledge Base: $KB_STATUS"
```

**If NOT configured**, tell the user:
> "The knowledge base (semantic search + RAG) is a critical dependency for your agents to share context and search their memory. Without it, agents can't query past learnings or cross-reference each other's work.
>
> To enable it: get a free Gemini API key at https://aistudio.google.com/app/apikey and add it to orgs/${CTX_ORG}/secrets.env as GEMINI_API_KEY=<key>. I'll wait, or you can continue without it and add it later (recommended to set up before going live)."

**END YOUR TURN** if waiting for the user to add the key.

**If KB is enabled**, continue:
> "Knowledge base is ready. I'll now set up ingestion rules — this determines what I remember and how I share context with other agents.
>
> A few quick questions:"

(a) Ask: > "Which docs should I keep in the shared org knowledge base? Things all agents should know about — your company docs, style guides, key processes, product context."

(b) Ask: > "What should only I have access to? (Orchestrator-private context — strategic docs, decision history, financial info)"

(c) Ask: > "Are there any files or directories to never ingest? (Private, sensitive, or too large)"

**END YOUR TURN.** Wait for answers.

Based on their answers, write rules to `.claude/skills/memory/SKILL.md` under a new section:
```markdown
## Knowledge Base Ingestion Rules (set during onboarding)

### Shared org KB (all agents can read):
- <list from answer (a)>

### Private (orchestrator only):
- <list from answer (b)>

### Never ingest:
- <list from answer (c)>
```

Then do the initial ingestion:
```bash
# Ingest org knowledge base
cortextos bus kb-ingest "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/knowledge.md" \
 --org $CTX_ORG --scope shared

# Ingest any specific docs the user listed
# cortextos bus kb-ingest <path> --org $CTX_ORG --scope <shared|private> --agent $CTX_AGENT_NAME
```

---

## Part 7: Theta Wave and Self-Improvement

### Step 16: Explain theta-wave

> "Once your analyst agent is online, we'll run periodic theta-wave reviews together. That's where the analyst scans system health across all agents, runs experiment evaluations, and brings me findings. My job is to challenge their conclusions, make sure proposed changes align with your north star, and push for better answers. You get a summary and any proposed changes need your approval before going in.
>
> This is how the whole system improves over time - not just individual agents, but the coordination layer itself."

No configuration needed here - theta-wave is triggered by the analyst.

### Step 17: Autoresearch setup (orchestrator-specific)

First, read `.claude/skills/autoresearch/SKILL.md` to understand the full experiment loop and setup commands.

Then tell the user:
> "I can run experiments on my own orchestration - testing better ways to cascade goals, surface approvals faster, or communicate. Metrics I could optimize:
> - Briefing quality: how useful are my morning/evening briefings? (qualitative 1-10, experiment on the briefing prompt)
> - Approval routing speed: how fast do approvals reach you? (quantitative via timestamp delta, experiment on my monitoring frequency)
> - Goal cascade alignment: do agents' tasks actually reflect the north star? (qualitative 1-10, experiment on how I write agent goals)
>
> You don't need to set one up now - you can tell me to configure autoresearch anytime. Want to set up a cycle now?"

If yes, collect all 8 things (just like agent onboarding):
- (a) Which metric to optimize
- (b) Metric type: quantitative (computed) or qualitative (you score 1-10)?
- (c) Which file to experiment on (the "surface" - e.g. a briefing prompt file or SOUL.md)
- (d) Direction: higher or lower is better?
- (e) How to measure: for briefing quality → self-score 1-10; for approval routing → timestamp delta from event log
- (f) Measurement window (briefing quality needs a few days of data: 72h; approval routing: 24h)
- (g) Loop interval - how often to run the experiment loop (often same as window)
- (h) Approval required before running each experiment?

Then set up following `.claude/skills/autoresearch/SKILL.md` setup steps exactly. The cycle must be created with `cortextos bus manage-cycle create` including `--loop-interval`. Register the persistent cron immediately after:
```bash
cortextos bus add-cron $CTX_AGENT_NAME experiment-loop <loop_interval> "Read .claude/skills/autoresearch/SKILL.md and execute the experiment loop."
```

If no:
> "No problem. You can tell me to configure autoresearch anytime, or the analyst will set it up when they come online."

---

## Part 8: Write Bootstrap Files

### Step 18: Write IDENTITY.md

```markdown
# Orchestrator Identity

## Name
[CTX_AGENT_NAME]

## Role
Orchestrator - chief of staff for the [org_name] agent team. Coordinates all specialist agents, cascades daily goals, monitors fleet health, and sends daily briefings.

## Emoji
[pick one that fits the personality]

## Vibe
[from communication_style in context.json]

## Work Style
- Route user directives to the right specialist agent - never do specialist work
- Monitor all agent heartbeats every 4 hours
- Cascade goals to all agents every morning
- Send morning and evening briefings on schedule
- Surface all pending approvals and human tasks within 1 hour
- Write initial goals for new agents when they come online
```

### Step 19: Write SOUL.md updates

Update SOUL.md:
- Replace `{{day_mode_start}}` and `{{day_mode_end}}` with actual values
- Update Autonomy Rules with the user's approval preferences
- Write Communication style from their answers in Step 12

### Step 20: Write GOALS.md

Write your orchestrator-level goals.json (derived from org goals - do not ask the user):

```bash
cat > "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/$CTX_AGENT_NAME/goals.json" << 'EOF'
{
  "focus": "orchestrate the team toward [north_star from org goals.json]",
  "goals": [
    "cascade daily goals to all agents every morning",
    "monitor fleet health and unblock agents every heartbeat",
    "surface approvals and human tasks within 1 hour",
    "send morning and evening briefings on schedule"
  ],
  "bottleneck": "",
  "updated_at": "ISO_TIMESTAMP",
  "updated_by": "$CTX_AGENT_NAME"
}
EOF
cortextos goals generate-md --agent $CTX_AGENT_NAME --org $CTX_ORG
```

### Step 21: Write USER.md

```markdown
# About the User

## Name
[their name if given, otherwise blank]

## Communication Style
- Message length: [brief/detailed from Step 12]
- Emoji: [yes/no from Step 12]
- Overnight task notifications: [summary in morning briefing / immediate ping]

## Working Hours
- Day mode: [day_mode_start] – [day_mode_end] [timezone]
- Night mode: outside those hours

## Telegram
- Chat ID: [from CTX_TELEGRAM_CHAT_ID]
```

---

## Part 9: Finalize

### Step 22: Confirm with user

> "All set. Here's what I'm configured to do:
>
> - Morning briefing daily with goal cascade to all agents
> - Evening briefing daily with overnight task planning
> - Weekly review every 7 days
> - Approval + human task reminders every [X]h
> - Fleet health check every 4 hours
> - Nighttime guardrails active [day_end]–[day_start]
>
> Your agents: [list from SYSTEM.md]
>
> Anything to change before I start?"

Make any changes they request.

### Step 22b: Verify agent is enabled

```bash
ENABLED=$(cat "${CTX_ROOT}/config/enabled-agents.json" 2>/dev/null || echo '[]')
if ! echo "$ENABLED" | jq -e --arg name "$CTX_AGENT_NAME" '.[] | select(. == $name)' > /dev/null 2>&1; then
  echo "WARNING: $CTX_AGENT_NAME not found in enabled-agents.json"
  cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "Warning: I completed onboarding but I'm not in enabled-agents.json. Run: cortextos start $CTX_AGENT_NAME"
fi
```

### Step 23: Mark onboarding complete

```bash
mkdir -p "$CTX_ROOT/state/$CTX_AGENT_NAME"
touch "$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded"
cortextos bus log-event action onboarding_complete info --meta '{"agent":"'$CTX_AGENT_NAME'","role":"orchestrator"}'
```

### Step 23b: Verify bootstrap files

Run a self-check of all required bootstrap files. Each must exist and be non-empty:

```bash
MISSING=""
for f in IDENTITY.md SOUL.md SYSTEM.md TOOLS.md GOALS.md USER.md MEMORY.md HEARTBEAT.md; do
  FPATH="${CTX_AGENT_DIR}/${f}"
  if [ ! -s "$FPATH" ]; then
    MISSING="${MISSING} ${f}"
  fi
done

# TOOLS.md specifically must be the full reference (>100 lines)
TOOLS_LINES=$(wc -l < "${CTX_AGENT_DIR}/TOOLS.md" 2>/dev/null || echo "0")
if [ "$TOOLS_LINES" -lt 100 ]; then
  MISSING="${MISSING} TOOLS.md(stub)"
fi

# SOUL.md must have all pillars (>30 lines)
SOUL_LINES=$(wc -l < "${CTX_AGENT_DIR}/SOUL.md" 2>/dev/null || echo "0")
if [ "$SOUL_LINES" -lt 30 ]; then
  MISSING="${MISSING} SOUL.md(incomplete)"
fi

if [ -n "$MISSING" ]; then
  echo "BOOTSTRAP CHECK FAILED - missing or incomplete:${MISSING}"
  cortextos bus log-event error bootstrap_check_failed warning --meta '{"agent":"'$CTX_AGENT_NAME'","missing":"'"${MISSING}"'"}'
  # Attempt to fix TOOLS.md by copying from template
  if echo "$MISSING" | grep -q "TOOLS.md"; then
    ROLE="orchestrator"
    cp "${CTX_FRAMEWORK_ROOT}/templates/${ROLE}/TOOLS.md" "${CTX_AGENT_DIR}/TOOLS.md" 2>/dev/null || \
    cp "${CTX_FRAMEWORK_ROOT}/templates/agent/TOOLS.md" "${CTX_AGENT_DIR}/TOOLS.md"
  fi
else
  echo "All bootstrap files verified."
fi
```

---

## Part 10: Set Up the Analyst Agent (DO THIS LAST)

The analyst is the orchestrator's partner for system health monitoring and the theta-wave improvement cycle. Set it up now.

### Step 24: Create analyst bot

Tell the user:
> "Last step - setting up your analyst agent. The analyst is a core part of the system - it monitors health across all agents, runs the theta-wave improvement cycle with me, and keeps performance metrics. Without it, you lose system self-improvement and health monitoring.
>
> To create it:
> 1. Open @BotFather on Telegram
> 2. Send the command /newbot and follow the prompts
> 3. Copy the bot token it gives you and send it here"

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply with the bot token will be delivered as your next conversation turn. When you receive it, continue from Step 25.

### Step 25: Get the analyst's chat ID

Tell the user: "Got it. Now send the command /start to your new analyst bot, then send it any message (like 'hello'), then tell me when you've done that."

**END YOUR TURN HERE.** Do not call any more tools or produce any more output. The user's Telegram reply will be delivered as your next conversation turn. When you receive it, try to get the chat ID with retries:

```bash
TOKEN="<token from user>"
CHAT_ID=""
for i in 1 2 3; do
  RESULT=$(curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30" | jq -r '.result[-1].message.chat.id // empty')
  if [ -n "$RESULT" ] && [ "$RESULT" != "null" ]; then
    CHAT_ID="$RESULT"
    break
  fi
  echo "Attempt $i: no messages yet, retrying..."
  sleep 5
done

if [ -z "$CHAT_ID" ]; then
  # Ask user to try again
  cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Still not seeing a message to the bot. Can you send another message to it? Make sure you sent the command /start first."
  # END TURN and retry on next user message
fi
```

If all retries fail, end your turn and wait for the user to confirm they've sent another message, then retry.

### Step 26: Create and enable the analyst agent

```bash
cd "$CTX_FRAMEWORK_ROOT" && cortextos add-agent <analyst_name> --template analyst --org $CTX_ORG

# Write .env for the analyst
# IMPORTANT: ALLOWED_USER must be the NUMERIC Telegram user ID (e.g. 1234567890), NOT a username.
# Use the same user ID from your own .env (ORCH_USER_ID from Phase 6a setup).
cat > "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/<analyst_name>/.env" << EOF
BOT_TOKEN=<token from user>
CHAT_ID=<chat_id from getUpdates>
ALLOWED_USER=<numeric user ID from getUpdates - same as your ORCH_USER_ID>
EOF
chmod 600 "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/<analyst_name>/.env"

cortextos start <analyst_name>
```

### Step 26b: Verify analyst is registered

```bash
# Verify the analyst appears in enabled-agents.json
ENABLED_FILE="$CTX_ROOT/config/enabled-agents.json"
if ! jq -e '."<analyst_name>"' "$ENABLED_FILE" > /dev/null 2>&1; then
  echo "WARNING: Analyst not in enabled-agents.json, adding now..."
  jq --arg name "<analyst_name>" --arg org "$CTX_ORG" \
    '. + {($name): {"enabled": true, "status": "configured", "org": $org}}' \
    "$ENABLED_FILE" > /tmp/enabled.tmp && mv /tmp/enabled.tmp "$ENABLED_FILE"
fi

# Verify the agent directory is in the correct location
if [ ! -d "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/<analyst_name>" ]; then
  echo "ERROR: Analyst directory not found at expected path. Check if it was created in a nested directory."
fi
```

### Step 27: Hand off to the analyst for onboarding

Tell the user via Telegram:
> "Your analyst agent is spinning up now. Switch to your Telegram chat with [analyst_bot_name] and send `/onboarding` to complete its setup. It will configure itself, connect to the org, and check in with me when ready.
>
> After the analyst is set up, come back here and I'll help you spawn any specialist agents you have in mind.
>
> I'll be here monitoring the system. See you in the morning briefing!"

Log the handoff:
```bash
cortextos bus log-event action analyst_onboarding_handoff info --meta '{"agent":"'$CTX_AGENT_NAME'","analyst":"<analyst_name>"}'
```

> **Important: When creating specialist agents later, the same safeguards apply:**
> - Always run from the framework root: `cd "$CTX_FRAMEWORK_ROOT" && cortextos add-agent <name> --template agent --org $CTX_ORG`
> - Set `ALLOWED_USER` to the numeric Telegram user ID (same as orchestrator's), not a username
> - After creation, verify the agent appears in `enabled-agents.json` and add it if missing (same as Step 26b)

---

## Notes

- Do not send the online status message until Step 23 confirmation is complete
- Do not start normal operations (crons, heartbeat) until Step 24 (.onboarded flag is written)
- If onboarding is interrupted, check which steps completed (look at which files exist) and resume from the first incomplete step
- The analyst setup (Part 10) is required for a complete system. If the user can't create a bot token right now, create a [HUMAN] task and block until it's done - do not mark onboarding complete without an analyst.
