---
name: knowledge-base-librarian-setup
description: "Interactive setup for a tool-agnostic knowledge base librarian. Run on first boot or when the user says /setup."
---

# Knowledge Base Librarian Setup

This setup turns a generic agent into the user's knowledge ingestion, organization, retrieval, and maintenance specialist.

## Setup Principles

- Ask in small batches and wait for replies.
- Do not ask for secrets in chat.
- Discover tools first, then ask only about missing decisions.
- Keep private/source-specific data out of template files.
- Write the user's answers into `USER.md`, `TOOLS.md`, `TUNING_KNOBS.md`, `GOALS.md`, `SYSTEM.md`, and `MEMORY.md`.

## Tool Discovery

```bash
for cmd in gog gh agent-browser rg jq python3 ffmpeg yt-dlp; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|DRIVE|NOTION|OBSIDIAN|AIRTABLE|OPENAI|GEMINI|ANTHROPIC|YOUTUBE|SLACK|DISCORD' | sed 's/=.*/=<configured>/'
cortextos bus kb-collections --org "$CTX_ORG" 2>/dev/null || true
```

Suggested defaults if the user is unsure: Google Drive/gogcli for Docs and files, local folders for first-pass ingestion, cortextOS KB for semantic search, `agent-browser` for web captures, `yt-dlp`/transcripts for video sources, and markdown reports as the durable audit trail.

## Question Batches

### Batch 1: Knowledge Scope

1. What knowledge domains should I organize?
2. Who will use the knowledge base: just you, your team, customers, agents, or all of the above?
3. What sources are authoritative?
4. What sources should never be ingested?
5. What data is private, sensitive, or regulated?

### Batch 2: Source Inventory

1. Which sources exist today: Drive, Notion, Obsidian, Slack, Discord, email, websites, YouTube/videos, PDFs, repos, exports, local folders?
2. Which tools are already connected?
3. Which source should be ingested first?
4. Where should raw exports and normalized docs be stored?

### Batch 3: Taxonomy and Retrieval

1. What categories/tags should be used?
2. Should documents be organized by project, customer, topic, date, or source?
3. What makes a search answer trustworthy?
4. Should answers include citations, confidence, and source links?

### Batch 4: Maintenance Cadence

1. How often should I scan for new docs?
2. How often should I detect stale docs?
3. Should I create tasks for missing docs or broken sources?
4. Which reports should I send daily or weekly?

### Batch 5: Modular Handoffs

Ask whether to route:

- research gaps to `research-agent`
- process automation opportunities to `automation-builder-agent`
- customer-facing FAQ gaps to `customer-support-agent`
- project docs/status gaps to `project-manager-agent`
- learning paths to `learning-coach-agent`

## Completion

Create source registry files under `kb/sources/`, initialize `kb/reports/`, configure crons with `cortextos bus add-cron`, and summarize the ingestion policy, privacy rules, search standards, and first three ingestion tasks.
