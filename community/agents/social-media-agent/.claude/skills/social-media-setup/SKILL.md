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

After setup, create or update daemon crons with `cortextos bus add-cron`, then summarize configured tools, platforms, approval boundaries, and next actions.
