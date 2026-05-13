# Comms discipline — human-facing summary

A 2026-05-14 24h comms audit found ~65% of boss's inbound traffic (25 of 39 messages) was zero-information loops:

- **devops-c standby chatter** — 14 messages/24h saying "no work, remaining stood down" → boss-ACK → agent-ACK-the-ACK
- **token-auditor ACK inflation** — 3 messages per heartbeat (status / boss-ACK / "ACK + next-heartbeat" closer)
- **`online — ready` Telegram on every session-refresh** — 3 of 7 Saurav-facing messages were duplicate restart pings
- **Boss over-acknowledgement** — boss replied "ACK. Good progress." to every status, fueling the loops above

This change switches the fleet from "push routine status as bus messages" to "log routine status as structured JSONL events; consumers query on demand". The discipline lives in one rule file plus one CLI plus one wrapper script — modular, mergeable, future-proof for growth.

## What changed

| Layer | File | Net change |
|---|---|---|
| Rule (canonical, committed) | `community/skills/comms-discipline/RULE.md` | new — single source of truth (7 rules) |
| Rule (operator-local override) | `.claude/rules/comms-discipline.md` | gitignored; optional shadow of canonical |
| Skill | `community/skills/comms-discipline/SKILL.md` | new — discoverable wrapper around the rule |
| Glossary | `community/skills/comms-discipline/event-actions.md` | new — canonical event-action vocabulary |
| CLI | `src/cli/agent-events.ts` | new — `read-agent-events`, `read-cycle-summary` |
| CLI registration | `src/cli/bus.ts` | +2 trailing lines (import + register), upstream-mergeable |
| Wrapper | `scripts/comms/send-telegram-guarded.sh` | new — Telegram dedupe + restart-reason gate |
| Per-agent overlay | `orgs/sb-personal/agents/<agent>/CLAUDE.md` | +5 lines per agent (single rule reference) |

Total upstream-file edit budget: **1 file, 2 lines** (mirrors the `docs_sb/usage_tracking` precedent — proven mergeable).

## Before / after example — token-auditor heartbeat

**Before (3 messages, ~140 tokens):**

```
agent → boss:  "Heartbeat cycle complete. Suppressing per protocol. Daily breach stable."
boss  → agent: "ACK. Good progress."
agent → boss:  "ACK. Continuing initialization monitoring."
agent → boss:  "Will report next heartbeat at 16:05 UTC."
```

**After (1 event, 0 messages):**

```bash
cortextos bus log-event action audit_run_complete info --meta '{
  "agent": "token-auditor", "cycle": "audit",
  "state_delta": false, "summary": "init phase, suppressing per protocol",
  "ingested": 0, "anomalies": 3, "suppressed": 3
}'
```

Boss queries when interested:

```bash
cortextos bus read-cycle-summary token-auditor --since 24h
```

## Querying agent state on demand

```bash
# Compact per-cycle view across the fleet (replaces 14 boss-inbound messages)
cortextos bus read-cycle-summary --since 24h

# Single agent, single cycle type
cortextos bus read-cycle-summary devops-c --since 24h --cycle heartbeat

# Drill into a specific event with full meta
cortextos bus read-agent-events token-auditor --since 4h --event audit_run_complete --format json

# Look for state-delta cycles (where action actually happened)
cortextos bus read-agent-events analyst --since 7d --event heartbeat_cycle_complete \
  | grep -E 'state_delta.*true'
```

## Adding the discipline to a new agent

1. In `orgs/<org>/agents/<new-agent>/CLAUDE.md`, near the top of "Session Start", add:
   ```markdown
   ## Comms discipline

   Follow `community/skills/comms-discipline/RULE.md` (or operator-local `.claude/rules/comms-discipline.md` if present). Pull-model: routine cycles → log-event, not send-message. `online — ready` only on cold-boot/crash. Use `scripts/comms/send-telegram-guarded.sh` for Telegram.
   ```
2. Append to the heartbeat cron prompt in the agent's `config.json`: `"Follow community/skills/comms-discipline/RULE.md."` (belt-and-suspenders).
3. Restart the agent.

That's the whole migration. The agent picks up the rule on session-start.

## Verification (post-rollout)

```bash
# Per-agent volume audit (re-run the same script from the 2026-05-14 baseline)
SINCE_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" "+%s")
for agent in boss analyst engineer devops fullstack devops-c token-auditor; do
  recent=$(find ~/.cortextos/default/processed/$agent -type f 2>/dev/null | while read f; do
    m=$(stat -f "%m" "$f" 2>/dev/null)
    [ "$m" -ge "$SINCE_EPOCH" ] && echo "$f"
  done | wc -l | tr -d ' ')
  echo "$agent | processed_24h=$recent"
done

# Cycle-event count over the same window (should rise as message count falls)
cortextos bus read-cycle-summary --since 24h | wc -l
```

Targets:
- boss inbound from devops-c ≤ 2/24h (down from 14)
- boss inbound from token-auditor ≤ 4/24h (down from 12)
- Saurav Telegram restart-noise count = 0

## Growth + modularity properties

- New agent in same org → add the one-line CLAUDE.md reference, restart. Done.
- New org (multi-company farm) → same one-line pattern. The rule file at `.claude/rules/` applies to any agent that reads it.
- New cycle type → add a row to `event-actions.md`. Agents start emitting; `read-cycle-summary --cycle <new>` finds it.
- Upstream changes event-log format → fix at the `cortextos bus log-event` CLI; the rule and agents are abstracted from the storage layout.
- Upstream adds new templates → the discipline is additive in fork-only paths; no merge conflict.

## Rationale (why this shape, not template edits)

Template edits to `templates/agent/CLAUDE.md` would have produced the same agent behaviour but at the cost of high upstream-merge surface. Every upstream change to those template files would conflict with our edits. The rule-and-overlay pattern keeps upstream files untouched: only `src/cli/bus.ts` gets the same 2-line trailing registration that `docs_sb/usage_tracking` already established as the canonical fork-extension pattern.

This matches the fork-sync hygiene rule in the root `CLAUDE.md`: minimise edit surface on shared paths, prefer additive new files in new directories.
