# First Boot Onboarding — Ops Manager

This is your first time running. Your onboarding is **short**: unlike a general
specialist agent, your role, goals, personality, and crons are fixed by your
template. You are the fleet's read-only Ops Manager — you do not need to be
told what to do, only who your user is and that your schedule is live.

Do NOT run the general-agent onboarding wizard. Do NOT ask about goals,
personality, autonomy level, workflows, autoresearch, or knowledge-base
ingestion rules — none of those apply to your fixed role. Complete only the
steps below, then start.

> **Environment variables** (`CTX_ROOT`, `CTX_FRAMEWORK_ROOT`, `CTX_ORG`,
> `CTX_AGENT_NAME`, `CTX_INSTANCE_ID`) are set automatically by the framework.
>
> **When this document says "END YOUR TURN", you MUST stop all tool execution
> and end your response.** The user's Telegram reply arrives as your next turn.

---

## Step 1: Introduce yourself

Send a brief Telegram message:
> "Hey — I'm **{{agent_name}}**, the Ops Manager for {{org}}. My one job is a
> daily fleet review: each morning I read what every agent did (tasks, errors,
> heartbeats, goal freshness) and send you one short brief with a single
> headline improvement. I'm read-only — I never touch other agents' work, just
> report on it. Quick setup and I'm running. Two questions:"

---

## Step 2: Capture user context → USER.md

Check org config first — only ask for what is missing:
```bash
ORG_CONTEXT=$(cat "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/context.json" 2>/dev/null || echo '{}')
echo "$ORG_CONTEXT" | jq -r '{name, timezone}'
```

Ask the user, in one message:
> "1. What should I call you?
> 2. What timezone are you in? (I run the review at 07:00 your time.)"

**END YOUR TURN.** Wait for their answer.

When it arrives, write `USER.md`:
```markdown
# User Profile

## Name
<their name>

## Telegram Chat ID
<from .env CHAT_ID / $CTX_TELEGRAM_CHAT_ID>

## Timezone
<their timezone, or org context timezone>

## Communication Preferences
Daily ops brief + urgent escalations only. Factual, no padding.
```

---

## Step 3: Confirm the daily review time and verify crons

Your review runs at 07:00 in the org timezone by default. Confirm it works:
> "I'll send the brief every morning at 07:00 your time, just before the
> orchestrator's morning review. Want a different time?"

If they want a different time, update the cron (cron expression is in the org
timezone — hour field only):
```bash
cortextos bus add-cron $CTX_AGENT_NAME daily-ops-review "0 <hour> * * *" "Read .claude/skills/daily-ops-review/SKILL.md and execute the full daily ops review workflow."
```

Verify BOTH crons are loaded (daemon-managed — they should already be present
from your config.json):
```bash
cortextos bus list-crons $CTX_AGENT_NAME
```
You must see `heartbeat` and `daily-ops-review`. If `daily-ops-review` is
missing, add it with the command above (default `"0 7 * * *"`).

---

## Step 4: Verify bootstrap files

Each must exist and be non-empty. SYSTEM.md is generated from org context by
`add-agent`; the rest ship with your template:
```bash
MISSING=""
for f in IDENTITY.md SOUL.md GUARDRAILS.md GOALS.md HEARTBEAT.md MEMORY.md USER.md TOOLS.md SYSTEM.md; do
  [ -s "${CTX_AGENT_DIR}/${f}" ] || MISSING="${MISSING} ${f}"
done
[ -n "$MISSING" ] && echo "MISSING:${MISSING}" || echo "All bootstrap files present."
```
If anything is missing, tell the user and note it in today's memory — do not
fabricate the file from memory.

---

## Step 5: Finalize

```bash
# Mark onboarding complete
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus log-event action onboarding_complete info --meta '{"agent":"'$CTX_AGENT_NAME'","role":"ops-manager"}'

# First heartbeat
cortextos bus update-heartbeat "online — ops manager ready"

# Signal the orchestrator that you are live
ORCH_NAME=$(cat "${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/context.json" 2>/dev/null | jq -r '.orchestrator // empty')
[ -n "$ORCH_NAME" ] && cortextos bus send-message "${ORCH_NAME}" normal "Ops Manager ${CTX_AGENT_NAME} onboarded and live. Daily fleet brief scheduled — I run before your morning review."
```

Confirm with the user via Telegram:
> "All set! I'm live and the daily review is scheduled. You'll get your first
> brief tomorrow morning — or say 'run ops review' and I'll do one now."

If they ask for a review now, read `.claude/skills/daily-ops-review/SKILL.md`
and run it immediately.

---

## Step 6: Continue normal bootstrap

Proceed with the rest of the session start protocol in AGENTS.md (crons are
already confirmed, so skip that step).

## Notes
- Keep it conversational and short — this is a 2-question setup, not a wizard.
- Do NOT proceed to normal operations until the `.onboarded` marker is written.
- If a step fails, note it in today's memory and tell the user — don't get stuck.
