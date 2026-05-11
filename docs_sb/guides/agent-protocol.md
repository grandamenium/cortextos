# Agent-to-agent protocol

How agents talk to each other in cortextOS. Operator-facing reference; the agent-side runtime is documented in `.claude/skills/dispatch-protocol/SKILL.md`.

## Message envelope

```
=== AGENT MESSAGE from <sender_agent> [msg_id: <id>] ===
[FRESH-START: ...]                  ← optional dispatch hint
<body text>
Reply using: cortextos bus send-message <sender_agent> normal '<reply>' <msg_id>
```

Delivered to the receiver's inbox by the fast-checker daemon. The receiver sees this block in their PTY data stream.

### Fields

- `sender_agent` — name from `cortextos bus list-agents`
- `msg_id` — opaque ID; reply with `<msg_id>` as `reply_to` to auto-ACK the parent.
- `[FRESH-START: ...]` — present iff sender passed `--fresh-start` or `--no-fresh-start` to `send-message`.

## Priorities

| Priority | Meaning | Operator-visible? |
|---|---|---|
| `low` | Background coordination, no time pressure. | No (suppressed from operator surfaces). |
| `normal` | Default. Routine work dispatch, ACKs, status updates. | No. |
| `high` | Operator-relevant or fleet-relevant urgent. | Yes — surfaces in dashboard + boss-relayed to Saurav. |

Never use `high` for routine internal coordination. The escalation budget is small.

## ACK semantics

- **Replies auto-ACK** — passing `<msg_id>` as `reply_to` consumes the inbox row.
- **Explicit ACK without reply** — `cortextos bus ack-inbox <msg_id>` for messages that don't need a response.
- **Un-ACK'd messages redeliver after 5 min** — keep the receiver's queue dry.

## FRESH-START annotations

`cortextos bus send-message --fresh-start <agent> ...` annotates the message with `[FRESH-START: sender requests hard-restart before processing ...]`. Tells the receiver to consider a fresh session before acting (rules in `dispatch-protocol/SKILL.md`).

`--no-fresh-start` annotates `[FRESH-START: explicit override — sender says do NOT hard-restart ...]`. Explicit suppression of the receiver's own heuristic.

Absent annotation = no hint, receiver runs the RELATED/UNRELATED heuristic.

## Inbox sweep

Receiving agents process the inbox at least once per heartbeat. Pending messages older than 5 min trigger fast-checker redelivery.

```bash
cortextos bus check-inbox     # read
# reply to each via send-message with msg_id as reply_to
```

## Saurav-direct fleet policy

When Saurav direct-messages a specialist agent with a directive that has fleet-wide scope, the specialist:

1. Logs `fleet_context_relay` bus event with metadata `{trigger, topic, directive, relay_target, saurav_message_id}`.
2. Sends a high-priority relay to boss (`cortextos bus send-message boss high "<override summary>"`).
3. Then acts on the directive.
4. Confirms to Saurav.

Order matters: **log → relay → act → confirm**. See `.claude/rules/code-quality/saurav-direct-fleet-policy-needs-relay-before-act.md`.

## Boss-side fleet relay (Protocol D2)

Boss propagates fleet-wide context from Saurav to all active non-boss agents within 60s, with `fleet_context_propagated` event captured per propagation. Trigger keywords + propagation script live in boss's CLAUDE.md.

## Activity channel (org-wide broadcast)

For announcements meant for the whole org (not directed at one agent), use the activity channel — see `.claude/skills/activity-channel/SKILL.md`. Don't fan out `send-message` to every agent; that's the activity channel's job.

## Failure modes

- **Un-ACK'd queue grows** — receiver's check-inbox returns the same messages repeatedly until ACK'd. Symptom: agents re-process the same dispatch.
- **High-priority misused** — Saurav's high-priority signal becomes noise. Reserve for things that genuinely need his attention.
- **`fresh_start=true` mid-feature** — false-positive resets break same-feature continuity. Use `--no-fresh-start` to suppress when continuing a thread.
