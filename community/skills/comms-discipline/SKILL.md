---
name: comms-discipline
description: |
  Pull-model fleet comms discipline. Routine cycle status → JSONL event log,
  not bus messages. `online — ready` Telegram only on cold-boot/crash. Boss
  replies only on state delta. Use when reviewing comms volume, designing
  agent cron prompts, building new agents, or troubleshooting "why is boss's
  inbox so noisy". Canonical rule at `.claude/rules/comms-discipline.md`.
triggers:
  - "ACK loop"
  - "comms volume"
  - "Telegram noise"
  - "inbox loop"
  - "online — ready"
  - "heartbeat status"
  - "push status"
  - "pull-model"
  - "boss inbox flooded"
  - "agent over-ACK"
---

# Comms discipline — pull-model fleet comms

## What it is

A fleet-wide rule + supporting CLI + wrapper script that switches cortextOS agents from "push routine status as bus messages" to "log routine status as JSONL events; consumers query on demand".

## When to use this skill

Activate this skill when:

- Reviewing comms volume across the fleet (24h audit, noise complaints, cost spikes)
- Spawning a new agent and wiring its CLAUDE.md / cron prompts
- Designing a new cycle type (audit, ingest, theta-wave) that produces status data
- Debugging "boss's inbox is full of zero-info messages"
- Tuning Telegram restart-ping noise
- Codifying ACK patterns for a new agent role

## The full rule

Canonical version: `community/skills/comms-discipline/RULE.md` (committed, ships with the fork). 7 numbered rules with examples and migration steps.

Per-operator override: `.claude/rules/comms-discipline.md` (gitignored, operator-local) may shadow the canonical with local overrides. If both exist, the operator-local file wins for the operator's instance only.

## Supporting tools

| Tool | Purpose |
|---|---|
| `cortextos bus read-agent-events <agent>` | Generic event reader. Filter by event name, category, severity, time window. |
| `cortextos bus read-cycle-summary [agent]` | Compact per-cycle status from `*_cycle_complete` events. Replaces 14 chat messages with one CLI call. Fleet-wide if no agent specified. |
| `scripts/comms/send-telegram-guarded.sh <chat> "<text>"` | Telegram wrapper. Dedupes identical text within 30 min; gates `online — ready` on restart reason. |
| `cortextos bus log-event action <name> info --meta '<json>'` | Existing event emitter. Used for all cycle-complete events. |

## Event-action vocabulary

See `community/skills/comms-discipline/event-actions.md` for the canonical glossary. Required schema for cycle events:

```json
{
  "agent": "<name>",
  "cycle": "heartbeat|audit|ingest|standby|theta_wave",
  "state_delta": true | false,
  "summary": "<one-line, ≤120 chars>",
  "inbox": <n>, "approvals": <n>, "tasks_in_progress": <n>
}
```

## How to apply this skill in a new agent

1. Add to the agent's `orgs/<org>/agents/<agent>/CLAUDE.md`, near the top of the Session Start section:
   ```markdown
   ## Comms discipline

   Follow `community/skills/comms-discipline/RULE.md` (or operator-local `.claude/rules/comms-discipline.md` if present). Pull-model: routine cycles → log-event, not send-message. `online — ready` only on cold-boot/crash. Use `scripts/comms/send-telegram-guarded.sh` for Telegram.
   ```
2. Optionally append to the heartbeat cron prompt in `config.json`: `"Follow community/skills/comms-discipline/RULE.md."`
3. Replace any per-agent CLAUDE.md instruction to send Telegram on session start with a call to the guarded wrapper:
   ```bash
   bash scripts/comms/send-telegram-guarded.sh $CTX_TELEGRAM_CHAT_ID "online — ready"
   ```
4. Restart the agent.

## How to audit comms volume

```bash
# 24h boss inbound message count by sender
SINCE_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "2026-05-13T00:00:00Z" "+%s")
for agent in boss analyst engineer devops fullstack devops-c token-auditor; do
  count=$(find ~/.cortextos/default/processed/$agent -type f 2>/dev/null | while read f; do
    m=$(stat -f "%m" "$f" 2>/dev/null)
    [ "$m" -ge "$SINCE_EPOCH" ] && echo "$f"
  done | wc -l | tr -d ' ')
  echo "$agent | processed_24h=$count"
done

# Cycle events written in the same window (should rise as messages fall)
cortextos bus read-cycle-summary --since 24h
```

Target after rollout: boss inbound from devops-c ≤ 2/24h (down from 14), from token-auditor ≤ 4/24h (down from 12). Saurav Telegram restart-noise = 0.

## Out of scope for this skill

- Cross-org event queries (single-org reader for v1; multi-org is one flag away).
- Auto-detection of `state_delta` (good-faith self-attestation for v1).
- Dashboard surfacing (CLI is enough for now).
