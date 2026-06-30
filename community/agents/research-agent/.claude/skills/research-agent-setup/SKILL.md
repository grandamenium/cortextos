---
name: research-agent-setup
description: "Configure the research agent template: niche, sources, scoring, delivery, approval policy, and recurring schedules."
---

# Research Agent Setup

Interactive setup. Prompts the user for all configuration values, writes the research configuration, and marks the agent ready for normal operation.

---

## When to Use

On first boot, or when the user asks to configure or reconfigure the research agent.

---

## Process

Ask the user each question in order. Accept their answer before moving to the next. Write the completed config at the end.

Before writing files, create or reuse a setup task, mark it `in_progress`, update heartbeat, and log `setup_started`.

```bash
TASK_ID=$(cortextos bus create-task "Complete research-agent setup" --desc "Configure research niche, sources, scoring, delivery, crons, memory, heartbeat, events, and onboarding state.")
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "WORKING ON: research-agent setup"
cortextos bus log-event action setup_started info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"research-agent\"}"
```

---

## Questions

1. **Agent name** -- What should this agent call itself? (default: Research Agent)
2. **Timezone** -- Your local timezone (e.g. America/New_York, Europe/London, Asia/Tokyo)
3. **Daily brief time** -- What local time should the daily research brief run? (default: 9am). The template's full schedule -- daily brief, evening topic briefing, weekly trends review, and weekly quality review -- is always installed; this only sets the daily brief time.
4. **Target audience** -- Who reads these briefs? (e.g. "technical founders building with AI", "content creators in the finance niche")
5. **Niche / product** -- What community, product, or topic is this agent serving? (used to tune business_fit scoring)
6. **Source categories** -- Which source types to enable? (GitHub, Reddit, YouTube, Hacker News, arXiv, RSS, custom URLs, Apify)
7. **GitHub sources** -- Topics to track (e.g. "ai-agents, llm-ops"), specific repos to monitor, or "none"
8. **Reddit communities** -- Subreddits to monitor (e.g. "LocalLLaMA, MachineLearning") or "none"
9. **YouTube channels** -- Channel handles or IDs to track via RSS or "none"
10. **RSS feeds** -- Any RSS/Atom feed URLs, comma-separated, or "none"
11. **Hacker News** -- Monitor HN top stories? (yes/no)
12. **arXiv queries** -- Search terms for arXiv (e.g. "agent memory, multi-agent systems") or "none"
13. **Custom URLs** -- Any specific URLs to fetch each run (changelogs, blog pages) or "none"
14. **Apify actors** -- Any Apify actor IDs to run (requires APIFY_TOKEN in .env) or "none"
15. **Scoring rubric** -- Use default rubric weights or customize? If customize: ask weight (1-10) for each dimension.
16. **Top N signals per run** -- How many signals to select and brief per run? (default: 8)
17. **Min score threshold** -- Minimum score to include a signal (default: 5.0)
18. **Signal categories** -- What categories to classify signals into? (e.g. "competitive intel, content opportunity, technical research, community signal")
19. **Content voice** -- Describe the content voice/style for brief writing (e.g. "direct, practitioner, no hype")
20. **Delivery destination** -- Where to send run summaries? (telegram / slack / local_markdown / none)
21. **Delivery credentials** -- If Telegram: use the agent's existing cortextOS Telegram channel. If Slack: webhook URL goes in `.env`, not config.
22. **Require approval before sending externally?** -- (yes/no, default yes)
23. **Dedup window** -- How many days back to deduplicate? (default: 7)
24. **Retain raw dumps?** -- Keep raw source dumps in research/output/? (yes/no, default yes)
25. **Privacy exclusions** -- Any topics, keywords, or sources to never include in output? (e.g. "competitor names, internal projects")

---

## Output

Write or update:

- `IDENTITY.md`
- `USER.md`
- `GOALS.md`
- `MEMORY.md`
- `TOOLS.md`
- `research/sources.json`
- `research/scoring-rubric.json`
- `config.json`

**Crons -- install ALL of the template's shipped crons** (do not reduce the set). The
template ships 5 crons in `config.json`; preserve every one, each with its full
skill-chain prompt and `update-cron-fire` call:

- `heartbeat` (`4h`)
- `daily-research-brief` (`0 9 * * *` -- adjust only the hour to the user's chosen brief time from Q3)
- `topic-briefing` (`0 18 * * *`)
- `weekly-trends-review` (`0 9 * * 1`)
- `research-quality-review` (`0 12 * * 5`)

Keep the shipped prompts verbatim. Only the `daily-research-brief` schedule changes to
match the user's preference -- do NOT drop the other crons or replace them with terse
run-only entries.

Write `.env` stub reminding user to add their API keys (if .env does not already exist).
Use `research.delivery.destination` and `research.delivery.requires_approval` for
delivery settings.

Never write secrets into committed files. Confirm: "Setup complete. Add your API keys to .env or org secrets. Your first run will fire at [next scheduled time]."

## Completion Contract

After writing the files:

1. Confirm daemon-managed crons exist and match the shipped names in `config.json`.

   ```bash
   cortextos bus list-crons "$CTX_AGENT_NAME"
   ```

   If any shipped cron is missing, add it with `cortextos bus add-cron` using the matching name, interval or cron expression, and prompt from `config.json`. Do not use session-local scheduling for persistent work.

2. Write a setup memory entry.

   ```bash
   TODAY_UTC=$(date -u +%Y-%m-%d)
   mkdir -p memory
   cat >> "memory/$TODAY_UTC.md" <<EOF

## Setup - $(date -u +%H:%M:%S UTC)
- Status: setup complete
- Current state: research sources, scoring rubric, delivery policy, crons, and approval boundaries configured.
- Next: run source collection, signal scoring, brief generation, and delivery routing on the configured schedule.
EOF
   ```

3. Mark onboarding complete, update heartbeat, complete the task, and log events.

   ```bash
   mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   cortextos bus update-heartbeat "online: research-agent setup complete"
   cortextos bus complete-task "$TASK_ID" --result "Configured research-agent template, verified crons, wrote memory, and marked onboarding complete."
   cortextos bus log-event task task_completed info --meta "{\"task_id\":\"$TASK_ID\",\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"research-agent\"}"
   cortextos bus log-event action setup_completed info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"research-agent\"}"
   ```

If setup cannot finish because a human must provide credentials or choose sources, create a human task with exact instructions and block the setup task until that dependency is resolved.
