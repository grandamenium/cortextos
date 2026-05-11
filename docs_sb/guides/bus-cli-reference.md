# `cortextos bus` CLI reference

Operator + agent reference for every `cortextos bus <verb>` command. Re-read with `--help` per command before relying on a flag — see `.claude/rules/code-quality/bus-cli-flag-source-of-truth.md`. This doc is a curated index of what's available; the binary is source of truth.

## Messages

| Verb | Purpose |
|---|---|
| `send-message <agent> <priority> '<text>' [reply_to]` | Send to another agent's inbox; priorities `normal\|high`. `[reply_to]` auto-ACKs the parent. |
| `check-inbox` | Read pending inbox messages for current agent. |
| `ack-inbox <msg_id>` | ACK a message without replying. Un-ACK'd messages redeliver after 5 min. |
| `send-telegram <chat_id> "<text>" [--image <path>]` | Send Telegram via current agent's bot. |
| `read-all-heartbeats [--format text\|json]` | Fleet liveness — orchestrator-side fleet health. |

## Tasks

| Verb | Purpose |
|---|---|
| `create-task "<title>" --desc "<desc>"` | New task. Returns `task_id`. |
| `update-task <id> <status>` | Status: `pending`, `in_progress`, `blocked`, `completed`. |
| `complete-task <id> --result "<summary>"` | Mark complete + 1-line outcome. |
| `list-tasks [--agent <name>] [--status <status>] [--assignee <name>]` | Filter tasks. |
| `list-approvals [--format json]` | Pending approvals. |

## Crons (daemon-managed)

| Verb | Purpose |
|---|---|
| `list-crons <agent>` | View scheduled crons. |
| `add-cron <agent> <name> <interval-or-cron-expr> <prompt>` | Register a new cron. Time-anchored cron fires once on registration — see `time-anchored-cron-fire-on-add` rule. |
| `update-cron <agent> <name> --interval <new>` | Modify schedule without re-firing. |
| `remove-cron <agent> <name>` | Delete. |
| `check-fresh-restart-cooldown` | JSON cooldown state — read before deciding hard-restart. |

`CronCreate` / `/loop` are session-only and do NOT survive restarts. Always use the bus commands above.

## Events / KPI

| Verb | Purpose |
|---|---|
| `log-event <category> <action> <severity> --meta '<json>'` | Append to event log. Categories: `action`, `task`, `restart`, `error`, `comms`, `kpi`. Severity: `info`, `warning`, `error`. |
| `update-heartbeat "<status>"` | Liveness tick — call on every cycle, even when idle. |
| `collect-metrics` | Run nightly metrics collector (analyst). |

## Sessions / lifecycle

| Verb | Purpose |
|---|---|
| `self-restart --reason "why"` | Soft restart — preserves conversation history. |
| `hard-restart [--fresh-start] --reason "why"` | Fresh session. `--fresh-start` writes `.last-fresh-restart-at` marker (consumes cooldown). Bare `hard-restart` is for context-overflow (FastChecker Tier 2/3); do NOT pass `--fresh-start` there. |
| `auto-commit` | Local snapshot — stages files with safety checks. Never pushes. |

## Knowledge base

| Verb | Purpose |
|---|---|
| `kb-query "<query>" --org <org>` | Natural-language KB search. |
| `kb-ingest <path> --org <org> --agent <name> --scope shared\|private [--force]` | Ingest document. **Flags are `--org`, `--agent`, `--scope`, `--force` — not `--collection`.** |
| `list-skills [--format text\|json]` | List available skills. |

## Agents / fleet

| Verb | Purpose |
|---|---|
| `list-agents [--format json]` | Live roster (running + enabled). |
| `add-cron-default` | Seed agent defaults on creation. |

## Approvals / human tasks

| Verb | Purpose |
|---|---|
| `create-approval "<title>" --desc "<desc>" --kind <category>` | Pending operator decision. |
| `list-approvals [--format json]` | Index. |
| `decide-approval <id> approve\|deny --reason "<why>"` | Operator-side. |

## Browse catalog (community skills)

| Verb | Purpose |
|---|---|
| `browse-catalog [--type skill\|agent\|org] [--tag <tag>] [--search "<q>"]` | Discover community items. |
| `install-community-item <name>` | Install after user-approved. |
| `prepare-submission <type> <source-path> <name>` | Stage local item for publication. |
| `submit-community-item <name> <type> "<description>"` | Open PR to community catalog. |

## Upstream sync

| Verb | Purpose |
|---|---|
| `check-upstream` | Fetch from grandamenium/cortextos; list diff. Read-only. |
| `check-upstream --apply` | Apply ONLY after explicit user approval per agent's upstream-sync skill. |

## Logs

Per-agent log paths (substitute `$CTX_INSTANCE_ID` and `$CTX_AGENT_NAME`):

| Log | Path |
|---|---|
| Activity | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/activity.log` |
| Fast-checker | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/fast-checker.log` |
| Stdout | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stdout.log` |
| Stderr | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stderr.log` |

Event JSONL: `~/.cortextos/$CTX_INSTANCE_ID/analytics/events/$CTX_AGENT_NAME/$(date -u +%Y-%m-%d).jsonl`.

## Common gotchas

- `gh` defaults to upstream parent on a fork — always `--repo saurav-yirifi/sb-cortextos-fork` explicit. See `gh-cli-fork-default` rule.
- Daemon-side config changes (model, max_session_seconds) need `pm2 restart cortextos`, not per-agent restart. See `daemon-side-config-requires-daemon-restart` rule.
- `--scope shared` makes a KB ingest visible to all agents in org; `--scope private` is per-agent.
- `--fresh-start` on `hard-restart` is for dispatch-driven transitions; bare `hard-restart` is for context overflow.
