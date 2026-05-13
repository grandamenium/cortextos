# Plan: Token Observability & Optimization Loop

A two-agent system — **token-auditor** (collects, attributes, logs) and **token-optimizer** (reviews findings, proposes structural improvements) — backed by a CLI, a SQLite fact store, and a recommendation lifecycle. Built in three phases, each independently useful.

## Context

cortextOS already produces the raw data needed to understand token spend, but it's scattered, inconsistently priced, and **causally opaque**. You can see *what* was spent (dashboard cost-parser, analyze.py) but not *why* — which trigger fired the session, which cron prompt was running, which files the spend attributed to, whether the work it produced was worth the cost, or whether the same waste pattern has been repeating for weeks. There's also nobody whose job is to *act on* the findings — proposing model downgrades, cron cadence changes, or hook removals based on observed patterns.

What's needed:
1. **Causal observability** — every dollar traceable from `agent → session → turn → tool-use → trigger → cron → config`, with stable IDs so any aggregate can drill back to raw evidence.
2. **Historical durability** — daily snapshots roll up into a queryable timeseries; "is this session anomalous *for this agent over the last 30 days*" must be answerable, not just "is this anomalous today."
3. **Automated improvement** — a dedicated agent that consumes the observability output and produces structured proposals with evidence, expected savings, blast radius, and a measurement plan. Never auto-applies; always proposes through the approvals path.
4. **Closed feedback loop** — after a proposal is approved and applied, the auditor measures actual savings against the hypothesis and writes the outcome back to the proposal record. Confirmed wins update memory.

Outcome: Saurav (or boss on his behalf) gets a daily plain-English digest *and* a weekly recommendation report ("here are 3 changes that would save ~$Y/week, evidence attached, approve any?"). Anomalies trigger immediate alerts. Every recommendation is traceable to raw turns.

## Design principles

These shape every component below:

- **Stable IDs everywhere.** Each turn carries `(agent, session_id, turn_id, ts)`; each anomaly, recommendation, and audit run carries a UUID. Nothing aggregates without preserving the IDs of its inputs — drill-back is non-negotiable.
- **Append-only event log for the auditor itself.** The auditor is observable: every run writes `audit_run_started` / `audit_run_completed` / `anomaly_detected` / `recommendation_proposed` events to `<CTX_ROOT>/analytics/events/token-auditor/*.jsonl` using the existing `event-logging` skill convention. Operators can see exactly what the auditor did, when, and why.
- **What / when / why on every record.** Each turn record stores not just the cost (what) and timestamp (when) but the trigger source, cron name, cron prompt, session opener, and parent message (why).
- **No silent auto-apply.** The optimizer agent proposes; humans (or the `approvals` skill flow) decide. Config changes outside the optimizer's own files require explicit Saurav approval per the approvals skill.
- **Reuse existing infra; don't invent parallel structures.** Dashboard's `cost-parser.ts` already has per-model pricing; SQLite is already in use; `analytics/events/<agent>/*.jsonl` is the established event-log shape; `templates/analyst/` is the established analyst archetype; agents already spawn through the existing daemon path. The auditor and optimizer are **just regular Claude agents** spawned via the existing `AgentPTY` path — no new lifecycle, no new launcher, no new file format.
- **Mergeability is a first-class constraint.** This repo is a fork of `github.com/grandamenium/cortextos`; upstream syncs happen regularly. The plan is structured so the new work is almost entirely **additive in new directories**, and the handful of touches to upstream files are surgical (single-line registrations) to minimize 3-way-merge conflicts. See the dedicated section below.

## Mergeability — minimize conflict surface against upstream

The fork tracks `grandamenium/cortextos` upstream; the `upstream-sync` skill periodically pulls in changes. The plan therefore follows three rules:

1. **Prefer additive files in new directories.** Every new piece of logic lives in a new path under `src/analysis/`, `src/cli/`, `templates/token-auditor/`, `templates/token-optimizer/`, or `community/skills/token-audit/`. No new files in existing modified directories where naming might collide.
2. **Plug-in registration over scattered edits.** The CLI hook into `src/cli/bus.ts` is a **single import line + single function call** added at the bottom of the file:
   ```ts
   // bottom of bus.ts, after existing subcommand registrations
   import { registerTokenAuditCommands } from './token-audit';
   registerTokenAuditCommands(busCommand);
   ```
   All the subcommand wiring lives in the new file `src/cli/token-audit.ts`. A 3-way merge against upstream is then mechanical: as long as upstream doesn't also touch the same trailing region, the merge auto-resolves.
3. **Don't refactor upstream files for our convenience.** Originally I proposed extracting `MODEL_PRICING` / `calculateCost` from `dashboard/src/lib/cost-parser.ts` into a shared module. **Reversed:** instead, **copy** the pricing table into `src/analysis/pricing.ts` and add a reconciliation check to Phase 1 verification (Phase 1 test asserts the two tables are byte-identical; the daily digest also asserts and surfaces drift). Pricing rarely changes; the duplication is cheap; the merge surface is zero. Similarly for `src/monitor/context-usage.ts`: instead of exporting `encodeCwdToProjectDir()`, reimplement the ~10-line function privately inside `src/analysis/token-audit.ts`. One less upstream file touched.

**Net upstream-file edit budget:** exactly one file, exactly two lines (the import + the call in `bus.ts`). Everything else is brand-new files. This is the maximum-mergeability shape.

If upstream later refactors `cost-parser.ts` or `context-usage.ts`, our duplicated copies keep working unchanged; the Phase 1 drift-check surfaces any pricing-table divergence on the next daily digest.

## Model selection — start cheap on haiku

Both agents are spawned through the **existing Claude agent setup** (the `AgentPTY` path in `src/daemon/agent-process.ts`; same one the analyst template uses today). No new agent mechanism — just config.

Per the fleet cost model memory (boss=sonnet, engineer=opus, analyst=haiku, devops=haiku), both new agents start on **haiku**:

- `templates/token-auditor/config.json` — `"model": "claude-haiku-4-5-20251001"`. The auditor's work is mostly tool use (run a CLI verb, parse JSON, format a digest) — haiku-class.
- `templates/token-optimizer/config.json` — `"model": "claude-haiku-4-5-20251001"`. The optimizer does more synthesis (turn anomalies + history into a structured proposal), but the schema is tight and the inputs are already constrained by the auditor's anomaly kinds. Haiku is a reasonable starting point.

**Escalation path:** if Phase-3 verification shows haiku struggling with proposal quality (e.g. weak hypotheses, missing evidence linkage), the optimizer's config.json model field is a one-line edit to `claude-sonnet-4-6`. The auditor stays on haiku regardless — its job is mechanical. This is itself an opportunity to dogfood the optimizer's `model_mismatch` anomaly kind: if the optimizer is genuinely too cheap, that anomaly will fire on the optimizer itself, which is the right feedback loop.

## Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │  RAW DATA SOURCES (already exist)                    │
                │                                                       │
                │  ~/.claude/projects/<encoded-cwd>/*.jsonl  (Claude)  │
                │  <CTX_ROOT>/logs/<agent>/codex-tokens.jsonl  (Codex)  │
                │  <CTX_ROOT>/logs/<agent>/codex-thread.jsonl  (Codex tools)
                │  <CTX_ROOT>/state/usage/<YYYY-MM-DD>.jsonl  (Anthropic usage API)
                │  <CTX_ROOT>/state/<agent>/heartbeat.json              │
                │  <CTX_ROOT>/analytics/events/<agent>/*.jsonl          │
                │  <agent-dir>/config.json  (cron prompts, model)       │
                │  <agent-dir>/crons.json   (cron schedule + last-fire) │
                └──────────────────────────────────────────────────────┘
                                       │
                                       ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  ENGINE  src/analysis/token-audit.ts                         │
       │                                                               │
       │   ingest → enrich (provenance) → attribute → detect →        │
       │   write fact store + emit events                              │
       └─────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  FACT STORE  <CTX_ROOT>/analytics/token-audit.sqlite         │
       │                                                               │
       │   turns, sessions, anomalies, idle_burn, audit_runs,         │
       │   recommendations, recommendation_outcomes, ab_pairs          │
       └─────────────────────────────────────────────────────────────┘
                          │                              │
                          ▼                              ▼
       ┌───────────────────────────┐    ┌────────────────────────────────┐
       │  CLI                       │    │  AGENTS                         │
       │  cortextos bus token-audit │    │                                 │
       │                            │    │  templates/token-auditor/       │
       │  summary | attribution |   │    │   (data plane: collects, alerts)│
       │  anomalies | idle-burn |   │    │                                 │
       │  ab-compare | explain |    │    │  templates/token-optimizer/     │
       │  alert-check | run         │    │   (control plane: proposes      │
       │                            │    │   structural improvements)      │
       └───────────────────────────┘    └────────────────────────────────┘
                          │                              │
                          ▼                              ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  SKILL  community/skills/token-audit/SKILL.md                │
       │  natural-language surface — any agent can trigger CLI verbs  │
       └─────────────────────────────────────────────────────────────┘
                          │                              │
                          ▼                              ▼
       ┌───────────────────────────┐    ┌────────────────────────────────┐
       │  Daily digest →           │    │  Weekly recommendations →       │
       │   activity channel        │    │   proposal records + Telegram   │
       │  Threshold alerts →       │    │   (Saurav approves via          │
       │   direct DM (via boss)    │    │    `approvals` skill flow)      │
       └───────────────────────────┘    └────────────────────────────────┘
```

## Provenance & traceability — the why-chain

The core observability primitive. Every assistant turn becomes a **fact row** with the full provenance chain attached, so any aggregate can answer "drill from this number to the actual turns that produced it."

**Turn fact row schema** (one row per assistant turn, stored in SQLite `turns` table and also as `turns-<YYYY-MM-DD>.jsonl` for portability):

```
turn_id          TEXT PRIMARY KEY   -- composite "agent::session_id::message_uuid"
agent            TEXT               -- from cwd → slug mapping
runtime          TEXT               -- 'claude' | 'codex'
session_id       TEXT
ts               TIMESTAMP
model            TEXT
input_tokens     INTEGER
output_tokens    INTEGER
cache_read       INTEGER
cache_write      INTEGER
usd_input        REAL
usd_output       REAL
usd_cache_read   REAL
usd_cache_write  REAL
usd_total        REAL
is_sidechain     BOOLEAN            -- subagent turn

-- WHY chain
trigger_kind     TEXT               -- 'cron' | 'user' | 'bus' | 'hook' | 'unknown'
trigger_name     TEXT               -- cron name, hook name, or sender agent
trigger_prompt   TEXT               -- the actual cron prompt or first user message (truncated)
session_opener   TEXT               -- first user message of the session (truncated)
parent_session   TEXT               -- for sidechain turns, the parent

-- WHAT chain (per-turn attribution)
tools_used       JSON               -- [{ name, file_path|command|subagent_type|pattern, input_chars }]
files_touched    JSON               -- canonical absolute paths from Read/Edit/Write
bash_verbs       JSON               -- ['git', 'npm', ...]
subagents_spawned JSON              -- ['Explore', 'Plan', ...]

-- audit metadata
audit_run_id     TEXT               -- which audit_runs row produced this fact
```

**Trigger resolution algorithm** (the "why"):

1. Load each agent's `config.json` crons (name + prompt) and `crons.json` (schedule + `last_fired_at`).
2. For each session, take the first user message text.
3. Match in priority order:
   - Starts with "=== AGENT MESSAGE from <X>" → `trigger_kind='bus'`, `trigger_name=X`.
   - Starts with "=== TELEGRAM" → `trigger_kind='user'`, `trigger_name='telegram'`.
   - Matches a cron prompt for this agent (Levenshtein ≤ 10%, or exact prefix of normalized prompt) **and** `crons.json[name].last_fired_at` is within ±2 minutes of `session.start_ts` → `trigger_kind='cron'`, `trigger_name=<cron-name>`.
   - Matches a hook stdout pattern (e.g. crash-alert templates from `src/hooks/*.ts`) → `trigger_kind='hook'`.
   - Otherwise → `trigger_kind='user'` (human-typed in the CC terminal).
4. For sidechain turns (`isSidechain: true`), inherit `trigger_*` from the parent session and set `parent_session`.

**Drill-back: `cortextos bus token-audit explain <id>`** (new verb, central to traceability):

- `explain agent:engineer --since 24h` → fleet-wide attribution chain summary for engineer.
- `explain session:28ec1a74` → the turn-by-turn timeline of that session: timestamps, models, tools, USD, what triggered each turn.
- `explain anomaly:<uuid>` → the anomaly record + every turn it cites, with verbatim trigger_prompt and session_opener.
- `explain recommendation:<uuid>` → proposed change + every turn that supports the hypothesis + expected vs actual savings (once measured).
- `explain file:/path/to/file.ts --since 30d` → every turn that touched this file, ordered by USD; useful for "why is this file so expensive."

Every aggregate the CLI prints includes a trailing `evidence_ids: [...]` field in JSON output so a follow-up `explain` call drills down without re-querying.

## Fact store — SQLite

Why SQLite: already in use by `dashboard/src/lib/cost-parser.ts` (the `cost_entries` table), trivial to query, supports the rollups and joins we need. New database file: `<CTX_ROOT>/analytics/token-audit.sqlite` (separate from dashboard's so neither blocks the other; the dashboard `cost_entries` table remains for the UI's existing path).

Tables:

- `audit_runs` — `(run_id, started_at, completed_at, scanned_files, turns_ingested, anomalies_detected, error)`. One row per `token-audit run` invocation. Provides the auditor's own audit trail.
- `turns` — schema above. Primary fact table.
- `sessions` — denormalized rollup: `(session_id, agent, runtime, started_at, ended_at, turn_count, usd_total, trigger_kind, trigger_name)`.
- `anomalies` — `(anomaly_id, audit_run_id, kind, severity, agent, session_id, evidence_turn_ids JSON, usd_impact, why_text, detected_at, status)`. `kind` ∈ `outlier_session | cache_runaway | compact_candidate | idle_burn | trigger_addiction | model_mismatch`.
- `idle_burn` — `(snapshot_date, agent, window_hours, usd_spent, tasks_completed, usd_per_task, verdict)`.
- `recommendations` — see lifecycle section below.
- `recommendation_outcomes` — see lifecycle section below.
- `ab_pairs` — `(pair_name, agent_a, agent_b, started_at, ended_at, verdict, evidence_run_ids JSON)`.

Rollup materialized views (refreshed nightly):
- `daily_agent_spend` — `(date, agent, model, usd, tokens)` for fast dashboard queries.
- `weekly_agent_spend` — ISO-week rollup.
- `monthly_agent_spend` — month rollup. Enables "is this anomalous *for engineer over 30 days*."

## Codex runtime parity

Codex (`gpt-5-codex` via `codex-app-server`) is in a 1-week A/B trial: `devops` (opus) vs `devops-c` (codex). First-class source, not afterthought.

- **Per-turn log:** `<CTX_ROOT>/logs/<agent>/codex-tokens.jsonl` (written by `appendCodexTokenLog()` at `src/pty/codex-app-server-pty.ts:857`). Dedupe by `(session_id, turn_id)` since the codex server can re-emit on reconnection.
- **Tool/file attribution:** also tail `<CTX_ROOT>/logs/<agent>/codex-thread.jsonl` if present — captures the codex agent's tool calls and file ops. Join with codex-tokens by `(session_id, turn_id)` to fill in the `tools_used` / `files_touched` columns.
- **Pricing:** already present in `dashboard/src/lib/cost-parser.ts:21` (`gpt-5-codex`: $1.25/$10/$0/$0.125 per M for in/out/cwrite/cread). The extracted `src/analysis/pricing.ts` preserves it.
- **A/B verdict:** `cortextos bus token-audit ab-compare --pair devops:devops-c [--since 7d]` reports per-agent total USD, tasks completed, USD/task, anomaly count, with a plain-English verdict ("devops-c spent 40% less per task but 2× cache-runaway anomalies — net signal weak; extend trial"). Configured via `TOKEN_AUDIT_AB_PAIRS=devops:devops-c,…`. Verdicts persist to the `ab_pairs` table.

## Component 1 — Engine: `src/analysis/token-audit.ts`

Single TypeScript module, pure functions plus an orchestrator. Writes to SQLite + emits events.

- `ingestTurns({ since, until, ctxRoot })` — walks the four raw sources, normalizes each turn to the fact-row schema, enriches with provenance (trigger resolution), writes to `turns` table. Incremental: skips turn_ids already present.
- `enrichAttribution(turnId)` — extracts `tools_used` / `files_touched` / `bash_verbs` / `subagents_spawned` from the raw turn content. Cost allocated to tool-use blocks proportionally by tool-input character count; turns with no tool use → 100% "text-generation" bucket.
- `aggregate(opts)` — slices the `turns` table by any combination of dimensions. Returns `{ rows, totals, evidence_ids }`.
- `detectAnomalies({ runId })` — six kinds:
  - `outlier_session` — sessions in top 5% project spend or > 3× project median.
  - `cache_runaway` — `cache_write / output > 50`.
  - `compact_candidate` — turns with `cache_read > 200k` at a safe boundary (port from `analyze.py`).
  - `idle_burn` — agent USD/task > 5× fleet median, or USD > 0 with zero completed-task events.
  - `trigger_addiction` — agent's heartbeat-fired spend > 3× its user-fired spend over 7d (overactive cron).
  - `model_mismatch` — opus agent whose 7d-median turn is < 50k context with no tool use (oversized model for the work). Powers optimizer recommendations.
- `runAudit({ since, until })` — orchestrator. Writes an `audit_runs` row, calls ingest → attribute → detect → write anomalies → emit events → return summary.
- `emitEvent(kind, payload)` — append to `<CTX_ROOT>/analytics/events/token-auditor/<YYYY-MM-DD>.jsonl` using the standard event shape (`{ ts, agent: 'token-auditor', kind, ...payload }`).

Reuses (extracted into `src/analysis/pricing.ts`): `MODEL_PRICING` + `calculateCost()` from `dashboard/src/lib/cost-parser.ts:21-28`. Slug resolution: `encodeCwdToProjectDir()` from `src/monitor/context-usage.ts`.

## Component 2 — CLI: `cortextos bus token-audit`

Registered in `src/cli/bus.ts` near `collect-metrics` (~line 994) / `scrape-usage` (~line 1003), same `commander` pattern.

Subcommands:
- `summary [--since 24h|7d|30d] [--by agent|model|day] [--format text|json]` — top-line spend.
- `attribution --by <tool|file|subagent|bash-verb|trigger|agent-x-trigger> [--top N] [--since 24h]` — slice spend by attribution dimension.
- `anomalies [--since 24h] [--kind <kind>]` — outliers + cache runaways + compact candidates + idle-burn + trigger-addiction + model-mismatch.
- `idle-burn [--since 24h]` — per-agent throughput-vs-spend table.
- `ab-compare --pair <a:b> [--since 7d]` — head-to-head verdict.
- `alert-check [--threshold-daily-usd N] [--threshold-hourly-usd N]` — exit-code 1 + JSON if breached.
- `explain <agent:X|session:X|anomaly:X|recommendation:X|file:X> [--since N]` — full why-chain drill-back.
- `history --agent X [--bucket day|week|month] [--since 90d]` — timeseries for a single agent; used by optimizer to detect long-running patterns.
- `recommend [--dry-run]` — generates recommendations from current fact-store state (called by token-optimizer agent).
- `run [--since 24h]` — convenience: ingest + attribute + detect + write daily snapshot.

Thresholds from env: `TOKEN_AUDIT_DAILY_USD_LIMIT` (default 50), `TOKEN_AUDIT_HOURLY_USD_LIMIT` (default 10), `TOKEN_AUDIT_AB_PAIRS`.

## Component 3 — Skill: `community/skills/token-audit/SKILL.md`

Standard YAML+markdown shape (follows `community/skills/system-diagnostics/SKILL.md`). Triggers: "audit tokens", "token usage", "where did our tokens go", "who is burning the most", "explain session", "compact candidates", "idle burn", "show recommendations", "drill into <session>". Body lists the CLI verbs with one-line use cases.

## Component 4 — Agent A: `templates/token-auditor/` (data plane)

Cloned from `templates/analyst/`. Persona: "watch the burn, surface waste, never silently let an agent runaway." Crons:

- `heartbeat` — 4h (inherited).
- `hourly-ingest` — 1h. Calls `cortextos bus token-audit run --since 1h`. Keeps the fact store fresh; cheap.
- `daily-digest` — 24h at 06:00 local. Calls `cortextos bus token-audit run --since 24h`, formats the digest in plain English (what / when / why / who's worth watching), posts to activity channel. Includes A/B verdicts for configured pairs.
- `threshold-check` — 30m. Calls `cortextos bus token-audit alert-check`. On non-zero exit, sends Telegram alert through boss-relay (per `feedback_overlap_route_through_boss` memory); on **sustained** breach (≥2 consecutive checks), direct-DM Saurav per `feedback_first_responder_owns_user_thread` rules.

Digest format follows the **"WHAT + WHY in plain English"** rule: "Yesterday the fleet spent $X. Engineer accounted for 60% — its 14:00 session was triggered by the `nightly-metrics` cron, then ran 2h of cache-thrashing in a single file. Top file: `dashboard/src/lib/cost-parser.ts` ($Y across 14 turns)."

`TOOLS.md` lists every `bus token-audit` verb per the `tool-registration` skill convention.

## Component 5 — Agent B: `templates/token-optimizer/` (control plane — the improver)

This is the agent the user specifically asked for: "dedicated agent whose only job is to review the results of the monitoring process and make improvements and recommendations." Cloned from `templates/analyst/` but specialized.

**Role:** consume the token-auditor's fact store, identify structural improvement opportunities, file structured proposals through the recommendation lifecycle. Never auto-applies; everything goes through approval.

**Crons:**
- `weekly-review` — 7d at Sunday 09:00 local. Runs `cortextos bus token-audit recommend`, reviews each proposal, attaches an executive summary, posts to activity channel + writes proposals to `<CTX_ROOT>/analytics/reports/token-audit/recommendations/<id>.json`. Notifies Saurav with a top-3 summary.
- `outcome-measurement` — 24h. For each `applied` recommendation, runs `token-audit explain recommendation:<id>` over the post-apply window and computes actual savings vs hypothesis. Writes outcome to `recommendation_outcomes` table. If actual < 50% of expected, files a follow-up proposal to revert.
- `heartbeat` — 4h.

**Recommendation kinds the optimizer can propose** (from the anomaly kinds detected by the auditor):
- **Model right-sizing** — `model_mismatch` anomalies → "downgrade agent X from opus to sonnet; 7d evidence: median turn 32k context, zero subagent calls, $Y/week current spend, projected $Z/week post-change." Files a proposal that edits `<agent-dir>/config.json` `model` field.
- **Cron cadence tuning** — `trigger_addiction` anomalies → "boss heartbeat fires every 4h but produces actionable output 30% of the time per the activity-channel event correlation; propose 6h. Evidence: <evidence_ids>." Edits `crons.json` interval.
- **Cron retirement** — proposes removal of crons whose 30d firing has produced zero `completed_task` events.
- **Hook removal** — for hooks whose fire-rate × per-fire cost exceeds value (measured by how often their output is consumed in downstream turns); rarer.
- **Subagent routing** — based on `--by subagent` attribution, propose preferring cheaper subagents (Explore vs general-purpose) for matched query patterns.
- **Compact strategy** — for sessions repeatedly hitting `compact_candidate`, propose adjusting the agent's CLAUDE.md context discipline rules.
- **A/B verdict adoption** — when `ab-compare` yields a clear winner over the trial window, propose decommissioning the losing pair member.

**Guardrails (in `templates/token-optimizer/GUARDRAILS.md`):**
- Never edits production code or agent configs directly. All changes are proposals.
- Never proposes a change with `expected_savings_usd_per_week < 1.0` (signal-to-noise floor).
- Always requires `evidence_ids ≥ 10 turns OR ≥ 7d of data` before proposing (no thin-evidence proposals).
- Routes all proposals through `approvals` skill flow per the user's standing rule.

## Recommendation lifecycle

Six-state machine; each transition emits an event and updates the SQLite row.

```
draft → proposed → approved → applied → measured → { kept | reverted }
                       │
                       └─→ rejected (terminal)
```

`recommendations` table:
```
id                TEXT PRIMARY KEY      -- uuid
kind              TEXT                  -- model-right-size | cron-cadence | cron-retire | ...
target            TEXT                  -- agent name, cron name, hook name, etc.
hypothesis        TEXT                  -- plain-English statement
proposed_change   JSON                  -- structured: { file: path, field: ..., from: ..., to: ... }
evidence_ids      JSON                  -- turn_ids / anomaly_ids supporting the hypothesis
window_start      TIMESTAMP             -- evidence window
window_end        TIMESTAMP
expected_savings_usd_per_week REAL
blast_radius      TEXT                  -- 'low' | 'medium' | 'high'
state             TEXT                  -- the six-state value above
created_at        TIMESTAMP
applied_at        TIMESTAMP             -- null until applied
notes             TEXT
```

`recommendation_outcomes` table:
```
id                  TEXT PRIMARY KEY     -- uuid
recommendation_id   TEXT REFERENCES recommendations(id)
measurement_window_start  TIMESTAMP
measurement_window_end    TIMESTAMP
actual_savings_usd        REAL
hypothesis_held           BOOLEAN
notes                     TEXT
```

Lifecycle wiring:
- `draft` (optimizer agent: internal, before notification).
- `proposed` (optimizer agent: written to JSON + posted to Saurav). Approval requested via `approvals` skill.
- `approved` / `rejected` (Saurav, via the approvals flow).
- `applied` (Saurav or boss applies the change manually OR — for low-blast-radius config-only changes Saurav has standing-authorized — boss applies and emits an event).
- `measured` (optimizer's `outcome-measurement` cron, after a configurable post-apply window — default 7d).
- `kept` / `reverted` (optimizer emits final-state event; if reverted, files a fresh proposal explaining why).

Confirmed-effective patterns get a memory entry (per the existing memory protocol): "downgrading boss from sonnet → haiku for heartbeat work saved $Y/week — keep" so future agents don't re-propose what's already settled.

## Logging discipline

The auditor itself is observable, not a black box.

- **Auditor events** at `<CTX_ROOT>/analytics/events/token-auditor/*.jsonl` and `<CTX_ROOT>/analytics/events/token-optimizer/*.jsonl` (one file per agent per day, per existing convention). Event kinds: `audit_run_started`, `audit_run_completed`, `audit_run_failed`, `anomaly_detected`, `threshold_breached`, `recommendation_proposed`, `recommendation_state_changed`, `recommendation_outcome_measured`.
- **Logs** (free-form) at `<CTX_ROOT>/logs/token-auditor/audit-run-<run_id>.log` for each run; verbose enough to debug "why did this run miss session X."
- Every CLI invocation that mutates state writes a `cli_invocation` event with the args, exit code, and elapsed time.
- The `cortextos bus token-audit run` exit code is always meaningful (0 = success, 1 = no data, 2 = ingest error, 3 = write error) so cron-failures are detectable from the daemon's perspective.

## Phasing

Three phases, each independently shippable and useful. Each phase is one PR; phase boundaries are commit boundaries (per Saurav's "one logical change per commit" + "ship primitive + callers together" rules).

### Phase 1 — Observability MVP (auditor data plane)
- `src/analysis/pricing.ts` (extracted from cost-parser).
- `src/analysis/token-audit.ts` engine: ingest + attribute + aggregate + detectAnomalies (4 kinds initially: outlier_session, cache_runaway, compact_candidate, idle_burn).
- SQLite fact store schema (turns, sessions, anomalies, audit_runs).
- CLI verbs: `summary`, `attribution`, `anomalies`, `idle-burn`, `alert-check`, `run`.
- `templates/token-auditor/` with `hourly-ingest` + `daily-digest` + `threshold-check` crons.
- Skill: `community/skills/token-audit/SKILL.md`.
- Closes the loop: daily digest + threshold alerts work end-to-end.

### Phase 2 — Provenance & history (the why-chain)
- Trigger resolution: `config.json` + `crons.json` reading, prompt-matching algorithm.
- Provenance enrichment: `trigger_kind / trigger_name / trigger_prompt / session_opener / parent_session` on every turn.
- CLI verbs: `explain`, `history`.
- New anomaly kinds: `trigger_addiction`, `model_mismatch`.
- Codex thread-log join for tool/file attribution on codex turns.
- A/B compare: `ab-compare` verb + `ab_pairs` table.
- Rollup materialized views (daily/weekly/monthly).

### Phase 3 — Optimizer agent + recommendation lifecycle
- `templates/token-optimizer/` with `weekly-review` + `outcome-measurement` crons.
- `recommendations` + `recommendation_outcomes` tables.
- CLI verb: `recommend`.
- Six-state lifecycle wiring with events.
- Integration with `approvals` skill for approval flow.
- Memory hooks for confirmed-effective patterns.

## Critical files

**Create (Phase 1):**
- `src/analysis/pricing.ts` — pricing table **copied** from `dashboard/src/lib/cost-parser.ts:21-28` (duplicated deliberately for mergeability; drift-check in Phase 1 verification).
- `src/analysis/token-audit.ts` — engine. Includes a private reimplementation of `encodeCwdToProjectDir()` (the ~10-line helper from `src/monitor/context-usage.ts`) to avoid editing that upstream file.
- `src/analysis/token-audit-schema.sql` — SQLite DDL.
- `src/analysis/token-audit.test.ts` — unit tests with fixture JSONL. Includes the pricing drift-check assertion.
- `src/cli/token-audit.ts` — `registerTokenAuditCommands(busCommand)` function. All subcommand wiring lives here; `bus.ts` only imports + calls it.
- `templates/token-auditor/` — full template directory (IDENTITY/SOUL/GOALS/GUARDRAILS/HEARTBEAT/MEMORY/USER/SYSTEM/CLAUDE.md + config.json + goals.json + TOOLS.md). `config.json` sets `"model": "claude-haiku-4-5-20251001"`.
- `community/skills/token-audit/SKILL.md`.

**Create (Phase 2):**
- `src/analysis/trigger-resolution.ts` — config.json + crons.json reader, prompt-matching.
- `src/analysis/explain.ts` — drill-back rendering for `explain` verb.
- `src/analysis/codex-thread-join.ts` — joins codex-tokens with codex-thread.

**Create (Phase 3):**
- `src/analysis/recommendations.ts` — proposal generation + state machine.
- `templates/token-optimizer/` — full template directory. `config.json` sets `"model": "claude-haiku-4-5-20251001"` (haiku start; escalation path documented in Model selection section).

**Modify (single upstream file, ~2 lines):**
- `src/cli/bus.ts` — append two lines at the bottom: `import { registerTokenAuditCommands } from './token-audit';` and `registerTokenAuditCommands(busCommand);`. No other changes. Phases 2 and 3 add their CLI verbs inside `src/cli/token-audit.ts` — no further edits to `bus.ts` needed in any phase.

**Reuse (no changes):**
- `dashboard/src/lib/cost-parser.ts` — left intact; we duplicate the pricing table. No merge conflict surface.
- `src/monitor/context-usage.ts` — left intact; we reimplement `encodeCwdToProjectDir()` locally. No merge conflict surface.
- `scripts/session-analysis/analyze.py` — kept as ad-hoc Python CLI; add a README note pointing at the new TS CLI for programmatic use (README edit is in a new-file-friendly subdir, low conflict risk).
- `src/pty/codex-app-server-pty.ts` `appendCodexTokenLog()` — already produces the right artifact.
- `src/daemon/agent-process.ts` — no changes; new agents spawn through the existing AgentPTY path automatically once their template dir exists.

## Verification

Per phase. Each phase must pass its full verification before the next starts.

### Phase 1 verification
1. **Unit:** `npm test` covering `src/analysis/token-audit.test.ts` with fixture JSONL. Assertions: per-model pricing matches dashboard cost-parser output to within rounding; anomaly detector flags a synthetic outlier session; idle-burn flags an agent with USD > 0 and zero `completed_task` events.
2. **Pricing-drift check:** unit test that imports both `src/analysis/pricing.ts` and `dashboard/src/lib/cost-parser.ts`'s `MODEL_PRICING` and asserts deep-equal. Fails the build if upstream changes the dashboard table without us syncing. The daily digest also performs this check at runtime and includes a warning line if drift is detected.
3. **Schema parity:** `cortextos bus token-audit summary --since 30d` USD totals match `dashboard analytics` page within rounding for the same window.
4. **CLI smoke:** every Phase 1 verb returns non-empty output against real local data and writes the expected SQLite rows + events.
5. **Auditor agent dry-run:** create `token-auditor` locally on **haiku**, manually fire `daily-digest` via dashboard test-fire, confirm the digest lands in activity channel and is plain English (no raw IDs in the message body). Confirm haiku is producing acceptable digest quality; if not, log the gap as input to the Phase-3 escalation decision rather than promoting now.
6. **Threshold alert dry-run:** force-low thresholds in `.env`, fire `threshold-check`, confirm Telegram alert arrives via the boss-relay path.
7. **Build:** `npm run build` clean; dashboard renders unchanged.
8. **Merge-safety check:** `git diff main...HEAD -- src/ dashboard/ scripts/` shows changes only in: (a) new files under `src/analysis/`, `src/cli/token-audit.ts`, `templates/token-auditor/`, `community/skills/token-audit/`; (b) **exactly two added lines** in `src/cli/bus.ts`. Any diff outside that footprint is a regression against the mergeability constraint and must be fixed before merge.

### Phase 2 verification
1. **Trigger resolution accuracy:** spot-check 20 random sessions; manually verify the resolved `trigger_kind` and `trigger_name` against the raw first-user-message. ≥18/20 must be correct.
2. **`explain` round-trip:** `token-audit anomalies --format json` returns evidence_ids; `token-audit explain anomaly:<id>` resolves them back to the same turns. Closed loop verified.
3. **`history` smoke:** `token-audit history --agent engineer --bucket week --since 90d` returns a chart-ready timeseries with the expected 13 weekly buckets.
4. **A/B compare:** `ab-compare --pair devops:devops-c --since 7d` produces a verdict line citing both Claude and Codex sources with USD/task numbers consistent with `attribution --by trigger`.
5. **New anomaly kinds:** synthetic-data unit tests for `trigger_addiction` and `model_mismatch` detection.

### Phase 3 verification
1. **Recommendation generation:** `cortextos bus token-audit recommend --dry-run` produces ≥1 proposal against real local data; every proposal has ≥10 evidence turns, plain-English hypothesis, structured `proposed_change`, non-zero `expected_savings_usd_per_week`.
2. **Haiku capability check:** read the first 5 generated proposals end-to-end. If hypothesis quality is weak (vague, missing evidence linkage, repetitive), flip `templates/token-optimizer/config.json` to `claude-sonnet-4-6`, regenerate, and compare. Document the decision and the trigger (which observed weakness). If haiku is adequate, stay on it.
3. **Lifecycle round-trip:** manually drive a proposal through `draft → proposed → approved → applied → measured → kept`; confirm event-log entries at each transition and the SQLite `state` column updates.
4. **Outcome measurement honesty:** apply a recommendation, wait the 7d window (or simulate with fixture data), confirm the `outcome-measurement` cron writes an honest `actual_savings_usd` row — including when the hypothesis fails. Verify the auto-revert proposal is filed when actual < 50% of expected.
5. **Optimizer agent dry-run:** fire `weekly-review` manually, confirm Saurav receives a top-3 summary, each item drillable via `explain recommendation:<id>`.
6. **Guardrail enforcement:** craft a thin-evidence anomaly (5 turns); confirm the optimizer's `recommend` skips it. Craft a $0.50/week candidate; confirm it's skipped.
7. **Merge-safety re-check:** repeat the Phase-1 `git diff` check. New files only under the established new directories; **zero further changes** to `src/cli/bus.ts` (Phase 2 and Phase 3 verbs are added inside `src/cli/token-audit.ts`, not bus.ts).

### End-to-end (after all phases)
- Use it. Run `cortextos bus token-audit explain session:<the most expensive session of the week>` and verify the why-chain renders fully: trigger, cron name + prompt, session opener, every tool used, every file touched, USD subtotals per tool, anomalies attached, any open recommendations referencing this session. If any of those fields is empty when it shouldn't be, the provenance pipeline has a hole — fix before declaring done.
