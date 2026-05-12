# Tools — Token-Auditor

The token-audit CLI verbs the agent uses to do its job. Per the `tool-registration` skill convention.

## token-audit run

```bash
cortextos bus token-audit run --since 24h [--dry-run]
```

Full ingest + detect pass. Writes turn facts, session rollups, anomalies, idle-burn rows, and an `audit_runs` log line. Use `--dry-run` to detect + report without persisting.

## token-audit summary

```bash
cortextos bus token-audit summary --by agent --since 24h
cortextos bus token-audit summary --by model --since 7d --format json
cortextos bus token-audit summary --by day --since 30d
```

Top-line spend rollup.

## token-audit attribution

```bash
cortextos bus token-audit attribution --by tool --since 24h
cortextos bus token-audit attribution --by file --top 30
cortextos bus token-audit attribution --by subagent
cortextos bus token-audit attribution --by bash-verb
cortextos bus token-audit attribution --by trigger
cortextos bus token-audit attribution --by agent-x-trigger --since 7d
```

Slice spend by attribution dimension.

## token-audit anomalies

```bash
cortextos bus token-audit anomalies --since 24h
cortextos bus token-audit anomalies --kind outlier_session
cortextos bus token-audit anomalies --format json
```

Detected anomalies in the window. Kinds: `outlier_session`, `cache_runaway`, `compact_candidate`, `idle_burn`, `trigger_addiction` (Phase 2), `model_mismatch` (Phase 2).

## token-audit idle-burn

```bash
cortextos bus token-audit idle-burn --since 24h
```

Per-agent USD-vs-tasks table.

## token-audit alert-check

```bash
cortextos bus token-audit alert-check
cortextos bus token-audit alert-check --threshold-daily-usd 30 --threshold-hourly-usd 5
```

Exit code 1 + JSON output if window USD breaches thresholds. Used by the threshold-check cron. Defaults from env: `TOKEN_AUDIT_DAILY_USD_LIMIT` (50), `TOKEN_AUDIT_HOURLY_USD_LIMIT` (10).

## Phase 2 verbs

- `token-audit explain <agent:X|session:X|anomaly:X|recommendation:X|file:X>` — full why-chain drill-back
- `token-audit history --agent X --bucket day|week|month --since 90d` — timeseries
- `token-audit ab-compare --pair a:b --since 7d` — A/B verdict

## Phase 3 verbs (optimizer-only)

- `token-audit recommend [--dry-run]` — generate recommendation proposals from current fact-store state
