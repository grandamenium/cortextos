---
name: knowledge-base-librarian-setup
description: "Interactive setup for a tool-agnostic knowledge base librarian. Run on first boot or when the user says /setup."
---

# Knowledge Base Librarian Setup

This setup turns a generic agent into the user's knowledge ingestion, organization, retrieval, and maintenance specialist.

Run this on first boot, when the user says `/setup`, or when `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is missing.

## Setup Principles

- Ask in small batches and wait for replies.
- Do not ask for secrets in chat.
- Discover tools first, then ask only about missing decisions.
- Keep private/source-specific data out of template files.
- Write the user's answers into `USER.md`, `TOOLS.md`, `TUNING_KNOBS.md`, `GOALS.md`, `SYSTEM.md`, and `MEMORY.md`.
- Default all sources and collections to private until the user explicitly marks a source shared.
- Do not activate external connectors, publish answers, or ingest into shared collections during setup without approval.

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

## Create Visible Setup Work

```bash
TASK_ID=$(cortextos bus create-task "Set up knowledge-base librarian agent" --desc "Initialize KB source registry, privacy policy, taxonomy, ingestion policy, schemas, examples, reports, crons, memory, goals, heartbeat, and onboarding marker.")
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "running knowledge-base-librarian setup"
cortextos bus log-event task task_created info --meta '{"task_id":"'"$TASK_ID"'","agent":"'"$CTX_AGENT_NAME"'"}'
```

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

Create source registry files under `kb/sources/`, initialize `kb/raw/manual`, `kb/normalized`, and `kb/reports/`, configure crons with `cortextos bus add-cron`, and summarize the ingestion policy, privacy rules, search standards, and first three ingestion tasks.

## Initialize Files

Create or verify these paths:

```bash
mkdir -p kb/raw/manual kb/normalized/manual kb/reports kb/sources kb/schemas kb/examples memory tmp
test -f kb/sources/source-registry.json || cp kb/examples/source-registry.example.json kb/sources/source-registry.json
test -f kb/sources/privacy-policy.json || cp kb/examples/privacy-policy.example.json kb/sources/privacy-policy.json
test -f kb/sources/taxonomy.json || cp kb/examples/taxonomy.example.json kb/sources/taxonomy.json
test -f kb/sources/ingestion-policy.json || cp kb/examples/ingestion-policy.example.json kb/sources/ingestion-policy.json
test -f kb/reports/setup-report.md || cp kb/examples/setup-report.example.md kb/reports/setup-report.md
test -f USER.md || touch USER.md
test -f TOOLS.md || touch TOOLS.md
test -f TUNING_KNOBS.md || touch TUNING_KNOBS.md
test -f GOALS.md || touch GOALS.md
test -f SYSTEM.md || touch SYSTEM.md
test -f MEMORY.md || touch MEMORY.md
```

Required assets that should already exist in the template:

- `kb/schemas/source-registry.schema.json`
- `kb/schemas/privacy-policy.schema.json`
- `kb/schemas/taxonomy.schema.json`
- `kb/schemas/ingestion-policy.schema.json`
- `kb/schemas/raw-doc.schema.json`
- `kb/schemas/normalized-doc.schema.json`
- `kb/schemas/ingestion-report.schema.json`
- `kb/examples/source-registry.example.json`
- `kb/examples/privacy-policy.example.json`
- `kb/examples/taxonomy.example.json`
- `kb/examples/ingestion-policy.example.json`
- `kb/examples/raw-doc.example.json`
- `kb/examples/normalized-doc.example.json`
- `kb/examples/ingestion-report.example.json`
- `kb/examples/setup-report.example.md`

## Configure Crons

Confirm or add persistent crons with the `cron-management` skill:

```bash
cortextos bus list-crons $CTX_AGENT_NAME
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h Read HEARTBEAT.md and AGENTS.md. Update heartbeat, inbox, tasks, memory, active ingestion review, and next safe action.
cortextos bus add-cron $CTX_AGENT_NAME weekly-kb-maintenance-review "0 10 * * 1" Review KB reports, stale docs, failed ingestions, retrieval quality, taxonomy drift, and safe next actions.
cortextos bus add-cron $CTX_AGENT_NAME weekly-source-registry-review "0 11 * * 1" Review source registry owner, privacy scope, connector status, collection target, approvals, and next review date.
```

If a cron already exists, do not duplicate it; update only if the user approves schedule changes.

## First Ingestion Candidate

If the user has no source ready yet, use the bundled local-first smoke path:

- Drop or create a small markdown/text file in `kb/raw/manual`.
- Register it as a private manual source in `kb/sources/source-registry.json`.
- Normalize it to `kb/normalized/manual`.
- Ingest only into the private agent collection.
- Verify with `kb-query`.
- Write `kb/reports/<batch-id>.ingestion-report.json` and a markdown summary.

## Completion Checklist

Setup is not complete until all of these are done:

1. `USER.md`, `TOOLS.md`, `TUNING_KNOBS.md`, `GOALS.md`, `SYSTEM.md`, and `MEMORY.md` exist and reflect setup decisions or explicit placeholders.
2. `kb/sources/source-registry.json`, `privacy-policy.json`, `taxonomy.json`, and `ingestion-policy.json` exist.
3. `kb/raw/manual`, `kb/normalized/manual`, `kb/reports`, `kb/schemas`, and `kb/examples` exist.
4. `kb/reports/setup-report.md` records privacy defaults, source owners, configured tools, first ingestion candidate, and open questions.
5. The setup task is completed, heartbeat is updated, setup events are logged, and daily memory is updated.
6. `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` is touched.

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
printf '\n## Setup - %s UTC\n- Initialized knowledge-base-librarian assets, private-by-default policies, schemas/examples, crons, setup report, and local manual ingestion path.\n' "$(date -u +%H:%M:%S)" >> "memory/$TODAY.md"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus update-heartbeat "knowledge-base-librarian setup complete"
cortextos bus complete-task "$TASK_ID" --result "Initialized KB librarian operating files, source registry, privacy policy, taxonomy, ingestion policy, schemas/examples, reports, recurring reviews, memory, and onboarding marker."
cortextos bus log-event action workflow_completed info --meta '{"workflow":"knowledge-base-librarian-setup","agent":"'"$CTX_AGENT_NAME"'"}'
```
