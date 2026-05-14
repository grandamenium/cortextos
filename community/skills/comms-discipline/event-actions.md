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

CLI emissions today are surfaced as a single console line (`event=port_collision_recovered port=... fallback_port=... holder_pid=...`) rather than a JSONL event, because the dashboard CLI runs in the operator's shell rather than under an agent identity. When the dashboard is supervised by the daemon (future), the same emission becomes a structured `logEvent` call under a system pseudo-agent.

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
