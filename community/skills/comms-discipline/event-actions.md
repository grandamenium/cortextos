# Canonical event-action glossary — comms-discipline

All cortextOS agents emit cycle status and silent-receipt events using this fixed vocabulary so `read-agent-events` + `read-cycle-summary` produce a uniform queryable stream. New cycle types extend the table; do NOT invent ad-hoc event names per agent.

## Cycle-complete events (suffix: `_cycle_complete`)

Read with `cortextos bus read-cycle-summary [agent] --cycle <name>`.

| Action | Emitted by | When | Required meta keys |
|---|---|---|---|
| `heartbeat_cycle_complete` | every agent | every heartbeat cron firing, after inbox sweep + status update | `agent`, `cycle: "heartbeat"`, `state_delta`, `summary`, `inbox`, `approvals`, `tasks_in_progress` |
| `audit_run_complete` | token-auditor, analyst (anomaly scan) | every audit/ingest run | `agent`, `cycle: "audit"`, `state_delta`, `summary`, `ingested`, `anomalies`, `suppressed` |
| `ingest_cycle_complete` | data-collector agents (token-auditor, external-signal future) | per ingestion run | `agent`, `cycle: "ingest"`, `state_delta`, `summary`, `records_ingested`, `errors` |
| `standby_cycle_complete` | agents that explicitly stay running on standby (devops-c, future) | per cycle while on standby | `agent`, `cycle: "standby"`, `state_delta`, `summary`, `idle_since` |
| `theta_wave_cycle_complete` | analyst | every theta-wave cycle (12h+) | `agent`, `cycle: "theta_wave"`, `state_delta`, `summary`, `findings`, `routed_to_saurav` |

## Boss-side observation events

Read with `cortextos bus read-agent-events boss --event inbox_archived`.

| Action | Emitted by | When | Required meta keys |
|---|---|---|---|
| `inbox_archived` | boss | when boss reads an inbound message and decides silent receipt (no reply justified per Rule 4) | `from_agent`, `msg_id`, `reason: "no_state_delta" \| "ack_only" \| "informational"` |

## Comms-layer suppression events

Read with `cortextos bus read-agent-events <agent> --event telegram_dedup_skipped`.

| Action | Emitted by | When | Required meta keys |
|---|---|---|---|
| `telegram_dedup_skipped` | `scripts/comms/send-telegram-guarded.sh` | when wrapper drops a duplicate Telegram (same text + same chat + within 30 min) | `chat_id`, `text_preview`, `last_sent_at`, `reason: "dup_text_30m" \| "session_refresh" \| "user_restart"` |

## Fleet-resilience watchdog events

Detection-side events emitted by daemon watchdogs and user-foreground CLIs (e.g. `cortextos dashboard`) when a latent fault is caught. See `docs_sb/plans/01-fleet-resilience-followups.md` for the full set; phases land incrementally. Currently shipped:

| Action | Emitted by | When | Required meta keys |
|---|---|---|---|
| `port_collision_recovered` | `cortextos dashboard` (CLI) | preferred port is occupied and the pre-bind probe falls through to a free fallback | `port`, `fallback_port`, `holder_pid` |
| `cron_dispatch_storm_detected` | `src/daemon/cron-dispatch-tracker.ts` | ≥3 distinct cron names fail to dispatch to the same agent inside a 30-min window (same cron repeating does NOT count) | `agent`, `crons` (string[]), `window_minutes` |
| `heartbeat_stale_detected` | `src/daemon/heartbeat-staleness-watcher.ts` | per-agent watcher sees `last_heartbeat` ts older than `heartbeat_stale_threshold_minutes` (default 10); re-fires every `heartbeat_stale_realert_minutes` (default 30) while still stale | `agent`, `age_seconds`, `threshold_seconds` |
| `heartbeat_recovered` | `src/daemon/heartbeat-staleness-watcher.ts` | heartbeat ts updates after a stale period — clears watcher state | `agent`, `was_stale_for_seconds` |
| `doctor_delta_detected` | `src/daemon/doctor-cron.ts` | periodic doctor run sees a `pass→warn`, `pass→fail`, `warn→fail` transition (or first run after daemon start with current warn/fail) | `new_failures` (string[]), `new_warnings` (string[]), `resolved` (string[]) |
| `crash_budget_reset` | `src/daemon/agent-process.ts` (per-agent) | planned restart (`cortextos bus {self,hard,soft}-restart`) succeeds and zeroes a non-zero `.crash_count_today` — earned trust. Auto-restart paths (CRASH, SPAWN-FAIL) never emit this | `agent`, `from_count` (number), `reason: "planned_restart"` |
| `node_modules_mtime_warning` | `src/daemon/agent-process.ts` (per-agent) | agent's start() observes `node_modules/package.json` mtime newer than `Daemon.daemonStartedAt` — strong precondition for the 2026-05-14 outage class (deps reinstalled with daemon running) | `agent`, `node_modules_mtime` (ISO ts), `daemon_started_at` (ISO ts) |

### Transport: stderr + JSONL under `_daemon`

The daemon-side watchdogs (`heartbeat-staleness-watcher`, `doctor-cron`, `cron-dispatch-tracker`) emit each event TWICE:

1. **Stderr structured line** — captured by the daemon log file. Shape:
   ```
   [<source>] <action> <key>=<value> <key>=<value> ...
   ```
2. **Structured JSONL** under the synthetic agent identity `_daemon` — queryable via `cortextos bus read-agent-events _daemon --event <action>`.

Examples on the wire:

```
[heartbeat-watcher] heartbeat_stale_detected agent="boss" age_seconds=672 threshold_seconds=600
[heartbeat-watcher] heartbeat_recovered agent="boss" was_stale_for_seconds=240
[doctor-cron] doctor_delta_detected new_failures=1 new_warnings=0 resolved=0
```

And the parallel JSONL row (one of many; written to `~/.cortextos/<instance>/orgs/<org>/analytics/events/_daemon/<YYYY-MM-DD>.jsonl`):

```json
{"id":"...","agent":"_daemon","org":"acme","timestamp":"2026-05-15T...","category":"action","event":"heartbeat_stale_detected","severity":"warning","metadata":{"agent":"boss","age_seconds":672,"threshold_seconds":600}}
```

The `port_collision_recovered` event is the only daemon-scope watchdog still stderr-only — it fires from the dashboard CLI, not the daemon, and so doesn't have a stable daemon identity in scope. Grep the dashboard log for it.

`crash_budget_reset` and `node_modules_mtime_warning` (and any other event that fires from a real `AgentProcess` rather than daemon scope) land as JSONL under the agent's own identity — not `_daemon`. Query those with the real agent name: `cortextos bus read-agent-events <agent> --event crash_budget_reset --since 24h`.

The `_daemon` agent identity passes `AGENT_NAME_REGEX` in `src/utils/validate.ts` (`/^[a-z0-9_-]+$/`) and is auto-discovered by `cortextos bus read-agent-events` via the `analytics/events/*` directory scan — no CLI flag changes needed. The underscore prefix sorts the synthetic identity ahead of real agents in directory listings.

**Querying examples:**

```bash
cortextos bus read-agent-events _daemon --event heartbeat_stale_detected --since 24h
cortextos bus read-agent-events _daemon --event cron_dispatch_storm_detected --since 7d
cortextos bus read-agent-events _daemon --event doctor_delta_detected --since 24h --format json
cortextos bus read-agent-events <agent> --event crash_budget_reset --since 24h
cortextos bus read-agent-events <agent> --event node_modules_mtime_warning --since 24h
```

## State-delta semantics

`state_delta` is a self-attested boolean. Set `true` when at least one of:

- inbox/approvals/tasks-in-progress count changed since the previous cycle
- agent's role status changed (e.g. standby → working, working → standby, error → healthy)
- the cycle produced new findings (anomaly, error, completion) that an operator would want to know about
- a watchdog flag (heartbeat stale, crash detected) fired

Set `false` for "I did my cycle, nothing changed" — the common idle case. This is the case that previously generated noise; `false` cycles produce events only, no bus message.

## Extending the glossary

When introducing a new cycle type:

1. Add a row to the cycle-complete table above with required meta keys.
2. The action name MUST end in `_cycle_complete` so `read-cycle-summary` finds it.
3. Update the discipline rule (`.claude/rules/comms-discipline.md`) Rule 1 canonical-names list if the new cycle is fleet-wide.
4. No code changes required — the CLI is data-driven against this glossary.

## Severity convention

- `info` — normal cycle completion, expected suppression
- `warn` — anomaly detected, threshold breached, watchdog tripped (still log; do not necessarily message — Rule 2 gate still applies)
- `error` — cycle failed (broken assumption, missing file, bus call returned non-zero). These SHOULD also send a bus message to boss because state changed.
