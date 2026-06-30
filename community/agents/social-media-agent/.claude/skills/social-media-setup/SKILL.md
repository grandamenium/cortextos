---
name: social-media-setup
description: "Interactive setup for a tool-agnostic social media/content agent. Run on first boot or when the user says /setup."
---

# Social Media Agent Setup

Run this when the user says `/setup` or when the agent has not been configured.

## Rules

- Ask in small batches and wait for the user's answer on Telegram.
- Never ask for secrets in chat. Ask the user to configure connectors, MCP, CLI auth, browser login, agent `.env`, or org `secrets.env`.
- Write final answers into `IDENTITY.md`, `USER.md`, `GOALS.md`, `TOOLS.md`, `SYSTEM.md`, `TUNING_KNOBS.md`, and `config.json`.
- Keep the template tool-agnostic. Suggest common defaults if the user is unsure: Google Workspace/gogcli for docs and calendar, agent-browser for browser posting/research, GitHub for source-controlled assets, RSS/Apify/YouTube transcript tools for research, and platform-native dashboards for TikTok/Instagram/YouTube/X/LinkedIn/Skool.
- Create the setup task before writing files. Mark it in progress, then complete or block it.
- Create local pipeline directories, starter config, approval state, analytics folders, goals, memory, heartbeat/event entries, and `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`.
- Do not publish, schedule, comment, reply, DM, edit, delete, or change live platform state during setup.

## Discovery

```bash
for cmd in gog gh agent-browser yt-dlp ffmpeg python3 jq rg; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|GMAIL|YOUTUBE|TIKTOK|INSTAGRAM|LINKEDIN|TWITTER|X_API|SKOOL|APIFY|NOTION|AIRTABLE|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
```

## Question Batches

### Batch 1: Brand and Voice

1. What brand/person/company is this agent supporting?
2. Who is the target audience?
3. What tone should posts use?
4. What topics are in scope?
5. What topics are off limits?

### Batch 2: Platforms and Assets

1. Which platforms should be managed: TikTok, Instagram, YouTube, X, LinkedIn, Skool, newsletter, blog, other?
2. Which platforms are read-only research vs draft-only vs approved-posting?
3. Where are source assets stored?
4. Where should drafts and approvals live?

### Batch 3: Content System

1. Preferred content pillars?
2. Preferred formats: shorts, carousels, long posts, threads, community posts, newsletters?
3. Publishing cadence and review cadence?
4. Any style rules, banned phrases, hooks, CTA rules, or brand examples?

### Batch 4: Approval and Risk

1. What may be drafted autonomously?
2. What always requires approval?
3. Can the agent schedule posts after approval?
4. Should the agent respond to comments/DMs, only triage them, or never touch them?

### Batch 5: Crons

Ask when to run:

- content research scan
- daily content brief
- draft pipeline review
- platform analytics digest
- stale approval nudge
- weekly content retro

## Output

## Setup Implementation

Use this sequence after the user answers the question batches.

1. Create and start a setup task:

   ```bash
   TASK_ID=$(cortextos bus create-task "Set up social media agent" --desc "Configure brand profile, platform config, content pipeline, crons, approvals, memory, and onboarding state.")
   cortextos bus update-task "$TASK_ID" in_progress
   ```

2. Create the local operating structure:

   ```bash
   mkdir -p config state tasks events memory \
     content/signals content/angles content/research content/drafts \
     content/approvals/pending content/approvals/approved content/approvals/rejected \
     content/scheduled content/published \
     content/analytics/daily content/analytics/weekly content/retros
   ```

3. Write `config/brand-profile.json` using `schemas/brand-profile.schema.json`.
4. Write `config/platform-config.json` using `schemas/platform-config.schema.json`.
5. Write `config/content-calendar.json` using `schemas/content-calendar.schema.json`.
6. Write `content/approvals/approval-state.json` with empty queues and the configured approval policy.
7. Update bootstrap files:

   - `IDENTITY.md`: agent role, supported brand, and platform scope.
   - `USER.md`: non-secret brand voice, audience, style rules, banned topics, approval boundaries.
   - `GOALS.md` and `goals.json`: active content goals and cadences.
   - `TOOLS.md`: configured connectors and local fallbacks.
   - `SYSTEM.md`: timezone, org, communication style, orchestrator if any.
   - `TUNING_KNOBS.md`: cadence, style filters, risk tolerance, analytics thresholds.
   - `MEMORY.md`: durable setup summary and first operating assumptions.

8. Register daemon crons from `config.json` or add equivalent runtime crons:

   ```bash
   cortextos bus add-cron "$CTX_AGENT_NAME" heartbeat 4h "Read HEARTBEAT.md and follow its instructions."
   cortextos bus add-cron "$CTX_AGENT_NAME" daily-content-brief "0 9 * * 1-5" "Run .claude/skills/content-research/SKILL.md and write the daily content brief."
   cortextos bus add-cron "$CTX_AGENT_NAME" draft-pipeline-review "0 13 * * 1-5" "Review drafts, approvals, and scheduled handoffs without external action unless approved."
   cortextos bus add-cron "$CTX_AGENT_NAME" analytics-digest "0 17 * * 5" "Run .claude/skills/analytics-digest/SKILL.md."
   cortextos bus add-cron "$CTX_AGENT_NAME" weekly-retro "0 10 * * 1" "Run .claude/skills/weekly-retro/SKILL.md."
   ```

9. Mark onboarding complete:

   ```bash
   mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   ```

10. Update heartbeat, log setup completion, write daily memory, and complete the task:

   ```bash
   cortextos bus update-heartbeat "social media agent setup complete"
   cortextos bus log-event action setup_completed info --meta '{"agent":"'$CTX_AGENT_NAME'","template":"social-media-agent"}'
   TODAY=$(date -u +%Y-%m-%d)
   mkdir -p memory
   printf "\n## Setup - %s\n- Brand/platform config created.\n- Content pipeline directories created.\n- Approval-gated external actions configured.\n- Crons registered.\n" "$(date -u +%H:%M:%S' UTC')" >> "memory/$TODAY.md"
   cortextos bus complete-task "$TASK_ID" --result "Configured social media agent template and marked onboarding complete."
   cortextos bus log-event task task_completed info --meta '{"task_id":"'$TASK_ID'","agent":"'$CTX_AGENT_NAME'"}'
   ```

After setup, summarize configured tools, platforms, approval boundaries, scheduled crons, and the first recommended content workflow. If any required connector or credential is missing, create a human task with exact setup steps and block the setup task until the user completes it.
