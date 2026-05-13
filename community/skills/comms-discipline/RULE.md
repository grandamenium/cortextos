# Comms discipline — canonical rule

**Canonical source.** Per-operator `.claude/rules/comms-discipline.md` may shadow this with local overrides, but this file is the committed canonical version that ships with the fork. New agents and new orgs reference this file directly.

This rule governs how agents talk to each other and to the operator. It exists because routine "push" messaging (status updates, ACKs of ACKs, restart pings) creates noise that buries real signal. The discipline switches the fleet to **pull-model**: routine status is logged as structured JSONL events; consumers query on demand.

## Rule 1 — Pull-model status (use log-event, not send-message)

Routine cycle completion is a fact, not a message. Log it as a structured event; do NOT send a bus message about it.

```bash
cortextos bus log-event action <cycle>_complete info --meta '{
  "agent": "'$CTX_AGENT_NAME'",
  "cycle": "heartbeat|audit|ingest|standby|theta_wave",
  "state_delta": true|false,
  "summary": "<one-line, ≤120 chars>",
  "inbox": <n>, "approvals": <n>, "tasks_in_progress": <n>
}'
```

Canonical action names: `heartbeat_cycle_complete`, `audit_run_complete`, `ingest_cycle_complete`, `standby_cycle_complete`, `theta_wave_cycle_complete`. Full glossary: `community/skills/comms-discipline/event-actions.md`.

Boss / analyst / Saurav query via:

```bash
cortextos bus read-cycle-summary <agent> --since 24h
cortextos bus read-agent-events <agent> --since 4h --event heartbeat_cycle_complete
```

## Rule 2 — State-delta gate (the only reason to message boss)

A bus `send-message` to boss (or another agent) is justified ONLY when at least one of:

- **state delta** — status changed materially since the last cycle (started/finished work, new error, new approval, exited standby)
- **action request** — you need a routing decision, approval, or another agent's work
- **question** — you need a clarification to proceed
- **page-level alert** — covered by `analyst/specs/integrity-protocols-v1.md` (those route DIRECT to Saurav, not through boss)

If none of these apply: log the event, stay silent. The event log is observable; the bus is for action.

## Rule 3 — No ACK-the-ACK

If an inbound reply contains no new direction (e.g. boss says "ACK. Good progress."), do NOT respond. The conversation is over. Your event log already captured your work; boss's ACK is acknowledgement of receipt, not a request for further reply.

Anti-pattern (currently observed in token-auditor):

```
agent → boss:  "Heartbeat: status X, suppressing per protocol"
boss  → agent: "ACK. Good progress."
agent → boss:  "ACK. Continuing initialization monitoring."   ← DO NOT SEND
agent → boss:  "Will report next heartbeat at 16:05 UTC."     ← DO NOT SEND
```

After Rule 1 + Rule 3 the entire exchange collapses to one event log entry. Net traffic: 0 messages.

## Rule 4 — Boss reply discipline

Boss replies to an inbound message ONLY when it requires:

- a routing decision (dispatch to another agent)
- an approval surface (push to Saurav)
- a clarification (question back to sender)
- a state-delta acknowledgement (the inbound was a delta, not a cycle)

For routine status updates (cycle complete, "still standing by", anomaly suppressed-per-protocol): boss reads-and-archives silently. Log `action/inbox_archived` with meta `{from_agent, msg_id, reason: "no_state_delta"}` so the silent receipt is observable in the event stream.

## Rule 5 — `online — ready` Telegram only on cold-boot or crash-recovery

Session-start `cortextos bus send-telegram "online — ready"` is gated on restart reason. Skip it when:

- restart reason is `session-refresh` (proactive 6h cron — Saurav doesn't need a ping)
- restart reason is `user-restart` (Saurav initiated; he knows)
- restart reason is `hard-restart` initiated by the agent itself (operational, not noteworthy)

Send it ONLY when reason is `cold-boot` (first start) or `crash-recovery` (previous exit was abnormal). These are the cases Saurav needs to know about.

Discover the reason by reading the most recent line of:

```bash
~/.cortextos/default/logs/$CTX_AGENT_NAME/restarts.log
```

That file is already populated by `src/bus/system.ts` on every restart with the line format `[<ts>] SELF-RESTART: <reason>` or `[<ts>] HARD-RESTART: <reason>`. Zero new infrastructure.

The wrapper script `scripts/comms/send-telegram-guarded.sh` enforces this gate automatically — agents should use it instead of bare `cortextos bus send-telegram` for any "online — ready" style ping.

## Rule 6 — Telegram dedupe (30-minute window per chat)

Use `scripts/comms/send-telegram-guarded.sh` for all Telegram pings to Saurav. The wrapper checks the last-sent cache (`~/.cortextos/default/logs/<agent>/last-telegram-<chatId>.txt`) and the recent `outbound-messages.jsonl`. If identical text was sent to the same chat in the last 30 minutes, the wrapper drops the call and logs `action/telegram_dedup_skipped` so suppression is observable.

This is a belt-and-suspenders defence — Rule 5 should prevent most duplicates already, but the dedupe catches anything Rule 5 misses (e.g. distinct agents restarting in parallel and all firing `online — ready` in the same window).

## Rule 7 — Canonical event-action vocabulary

All cycle-complete events use the suffix `_cycle_complete` so `read-cycle-summary` can find them. All Telegram-skip events use `telegram_dedup_skipped`. All silent boss-archives use `inbox_archived`. Full glossary with required meta keys lives at `community/skills/comms-discipline/event-actions.md`. New cycle types extend the glossary; do not invent ad-hoc event names.

---

## How agents adopt this rule

Each agent's `orgs/<org>/agents/<agent>/CLAUDE.md` includes a one-line reference:

```markdown
## Comms discipline

Follow `.claude/rules/comms-discipline.md`. Pull-model: routine cycles → log-event, not send-message. `online — ready` only on cold-boot/crash. Use `scripts/comms/send-telegram-guarded.sh` for Telegram.
```

Agents read CLAUDE.md (and the `.claude/rules/` directory) on every session start; the rule is in effect from boot.

## How operators verify discipline

```bash
# Per-agent cycle summary (replaces 14 chat messages with one CLI call)
cortextos bus read-cycle-summary devops-c --since 24h

# Fleet-wide
cortextos bus read-cycle-summary --since 24h

# Detail for a specific event
cortextos bus read-agent-events token-auditor --since 4h --event audit_run_complete --format json
```

## Migration guide for new agents

When spawning a new agent (via `cortextos add-agent` or any future onboarding flow):

1. The agent's CLAUDE.md gets the one-line reference above (verbatim — no per-agent customisation needed).
2. The agent's `config.json` heartbeat cron prompt appends: `"Follow .claude/rules/comms-discipline.md."` — belt-and-suspenders.
3. Restart the agent. On next heartbeat it emits `heartbeat_cycle_complete` events instead of bus messages to boss.

That's it. Modularity by construction: the rule lives once; agents reference it.
