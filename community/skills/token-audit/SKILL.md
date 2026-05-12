---
name: token-audit
description: "You need to understand where the fleet's token dollars went. Maybe an agent has been running away, maybe a cron is firing on no-op work, maybe a session blew up cache_write, maybe an opus agent is doing haiku-class work and you want to right-size. Or it's morning and you owe yourself a digest of yesterday's spend with attribution to triggers, files, and tools. This skill is the natural-language surface to the `cortextos bus token-audit` CLI verbs."
triggers: ["audit tokens", "token usage", "token spend", "where did our tokens go", "where did the dollars go", "who is burning the most", "explain session", "compact candidates", "idle burn", "cache runaway", "trigger addiction", "model mismatch", "ab compare", "show recommendations", "drill into session", "drill into anomaly", "right-size model", "cron cadence", "wasted cron", "daily digest", "token digest", "token alert"]
external_calls: ["cortextos bus token-audit run", "cortextos bus token-audit summary", "cortextos bus token-audit attribution", "cortextos bus token-audit anomalies", "cortextos bus token-audit idle-burn", "cortextos bus token-audit alert-check", "cortextos bus token-audit explain", "cortextos bus token-audit history", "cortextos bus token-audit ab-compare", "cortextos bus token-audit recommend"]
---

# Token-Audit

Use these to understand and act on fleet token spend.

---

## Big picture

`token-audit` is a two-agent system:
- **token-auditor** (data plane): ingests raw Claude + Codex token logs, attributes spend, detects anomalies. Reads + writes the fact store; never edits other agents' configs.
- **token-optimizer** (control plane, Phase 3): consumes the fact store and proposes structural changes — model downgrades, cron cadence tuning, hook removal, etc. Every proposal carries evidence_ids and expected savings. Never auto-applies; always goes through the `approvals` skill flow.

Below: the CLI verbs the auditor uses, plus the daily-digest composition recipe.

---

## Daily-pass workflow

Every 24h the auditor should run this sequence:

```bash
# 1. Full ingest + detect for the previous day
cortextos bus token-audit run --since 24h

# 2. Top-line summary
cortextos bus token-audit summary --by agent --since 24h --format json
cortextos bus token-audit summary --by model --since 24h --format json

# 3. Top files & tools
cortextos bus token-audit attribution --by file --top 10 --since 24h
cortextos bus token-audit attribution --by tool --top 10 --since 24h

# 4. Anomalies
cortextos bus token-audit anomalies --since 24h --format json

# 5. Compose the digest (see "Daily digest" below)
```

**When to run:** every morning at 06:00 local (daily-digest cron in `token-auditor/config.json`).

---

## Threshold-alert workflow

Every 30 minutes:

```bash
cortextos bus token-audit alert-check
echo "exit code: $?"  # 0=ok, 1=breach
```

Breach → route a Telegram alert through boss-relay. On a **sustained** breach (≥2 consecutive checks), direct-DM the user.

**When to run:** every 30m (threshold-check cron).

---

## Drilling back from an aggregate

Every `summary` / `attribution` / `anomalies` row carries `evidence_ids` in JSON output. To drill back:

```bash
# Find the most expensive session in the last 24h
cortextos bus token-audit summary --by session --since 24h --format json | jq '.rows[0]'

# (Phase 2) Drill into the session
cortextos bus token-audit explain session:<id>

# (Phase 2) Drill into the most recent anomaly
cortextos bus token-audit anomalies --since 24h --format json | jq -r '.anomalies[0].anomaly_id' \
  | xargs -I{} cortextos bus token-audit explain anomaly:{}
```

---

## Idle-burn check

```bash
cortextos bus token-audit idle-burn --since 24h
```

Per-agent USD vs `task_completed` events. Verdict `idle_burn` fires when:
- usd > 0 with 0 completed tasks in the window, OR
- usd/task > 5× fleet median.

**Action when fired:** check the agent's config — does it have a cron that runs but produces nothing? Did its heartbeat stop emitting `task_completed`? Note it in MEMORY.md; the optimizer's weekly review will pick it up.

---

## Cache runaway

```bash
cortextos bus token-audit anomalies --kind cache_runaway --since 24h
```

Cache-write/output ratio > 50 for a turn means the session is recomputing context faster than it's producing output — a classic sign of an agent thrashing because the working set won't fit. Look at the session's tool sequence to find the culprit (often a Read on a huge file followed by many small Edits).

---

## Compact candidates

```bash
cortextos bus token-audit anomalies --kind compact_candidate --since 24h
```

Sessions carrying ≥200k cached input tokens. These are sessions where `/compact` (operator-driven) would shed meaningful USD. The auditor can't invoke `/compact`; the agent's own heartbeat is the place to act (recommend operator-compact at yellow+, hard-restart at red).

---

## A/B compare (Phase 2)

For pairs like `devops` (opus, Claude) vs `devops-c` (gpt-5-codex):

```bash
cortextos bus token-audit ab-compare --pair devops:devops-c --since 7d
```

Reports per-agent USD, tasks completed, USD/task, anomaly count, plain-English verdict.

---

## Recommendations (Phase 3 — optimizer only)

```bash
cortextos bus token-audit recommend --dry-run     # see what the optimizer would propose
cortextos bus token-audit recommend               # generate proposals + write to recommendations JSONL
```

The optimizer agent runs this on its weekly-review cron. Proposals require ≥10 evidence turns OR ≥7d of data, and expected_savings_usd_per_week ≥ 1.0. Every proposal goes through Saurav for approval via the `approvals` skill.

---

## Daily digest — composition recipe

Run the queries in "Daily-pass workflow" above and assemble a plain-English summary. Required elements:

1. **Headline:** "Yesterday the fleet spent $X across N agents."
2. **Top spender:** "Agent Y accounted for Z% — driven primarily by <trigger>."
3. **Top file or tool:** "Most expensive file: <path> ($A across B turns)" OR "Most expensive tool: <tool> ($A)."
4. **Anomalies:** "M anomalies detected: K critical, J warning, L info." List the criticals by one-line why_text each.
5. **Pricing drift warning (if any):** if the runtime drift-check finds a mismatch between `src/analysis/pricing.ts` and `dashboard/src/lib/cost-parser.ts`, surface it here.
6. **(Optional) A/B pair verdicts** if any pairs are configured.

**Format rules:**
- Plain English in the message body. NO raw IDs (anomaly_ids, turn_ids).
- Evidence section attaches IDs as a JSON code block for the operator to drill back if interested.
- Length: target 6–10 lines + evidence block. A 30-line digest doesn't get read.

---

## When NOT to use this skill

- For a one-off "what did Claude spend today" check, use `cortextos bus collect-metrics` — it's faster and the dashboard already renders the result.
- For raw transcript analysis (assistant turn content, not just usage), use `scripts/session-analysis/analyze.py`. This skill is for fleet-level aggregates, not transcript reading.
