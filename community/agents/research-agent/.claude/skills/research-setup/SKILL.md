---
name: research-setup
description: "Interactive setup for a tool-agnostic research and intelligence agent. Run on first boot or when the user says /setup."
---

# Research Agent Setup

Run this when the user says `/setup`.

## Principles

- Ask in batches and wait for the user.
- Never ask for secrets in chat.
- Discover available tools first.
- Write answers into `IDENTITY.md`, `USER.md`, `GOALS.md`, `TOOLS.md`, `SYSTEM.md`, `TUNING_KNOBS.md`, and `config.json`.
- Suggested defaults if unsure: web search/browser, `agent-browser`, `gog` for Drive/Sheets/Docs, RSS feeds, Apify/scrapers, YouTube transcript tooling, Chroma/Gemini/OpenAI KB, GitHub for repo intelligence.

## Discovery

```bash
for cmd in agent-browser gog gh jq rg python3 yt-dlp ffmpeg; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'OPENAI|GEMINI|ANTHROPIC|APIFY|SERP|BRAVE|TAVILY|YOUTUBE|GITHUB|NOTION|AIRTABLE|GOOGLE' | sed 's/=.*/=<configured>/'
```

## Question Batches

### Scope

1. What should this agent research?
2. Who consumes the research?
3. What decisions should the research inform?
4. What sources are trusted, discouraged, or forbidden?

### Sources and Tools

1. Which tools can it use: web, RSS, APIs, databases, YouTube, social platforms, GitHub, internal docs, KB?
2. Which sources require credentials/connectors?
3. Where should raw data and final reports be stored?

### Output Standards

1. Preferred report format?
2. Citation requirements?
3. How should confidence and uncertainty be reported?
4. How should findings be routed to other agents or humans?

### Crons

Configure:

- ecosystem scan
- competitor/news scan
- source-specific monitors
- daily/weekly intelligence digest
- stale research review
- KB ingestion/re-index checks

## Completion

After setup, create crons with `cortextos bus add-cron`, create first research watchlist files under `research/watchlists/`, and summarize the configured research operating model.
