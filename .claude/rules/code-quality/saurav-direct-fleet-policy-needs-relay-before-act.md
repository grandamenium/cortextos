---
domain: [fleet-coordination, comms, audit-trail]
applies_to: [analyst, engineer, devops, fullstack]
severity: blocker
---

# Saurav-direct DMs to a specialist that touch fleet-wide policy need fleet_context_relay BEFORE acting

**When Saurav directly DMs a specialist agent (not boss) with a directive that has fleet-wide implications, the audit-primitive (`fleet_context_relay` bus event) must fire BEFORE the specialist acts on the directive — not after.** The relay event is the truth-of-record; the `send-message` to boss is the carrier. Both must fire, and the order matters.

Default-fire-on-borderline: any Saurav-direct DM that touches fleet-wide configuration triggers `fleet_context_relay` at info severity, even if just discussing it. Cheaper to over-fire than miss a real policy directive.

## Pattern fix

When Saurav-direct directive arrives with fleet-wide scope:

1. **Log `fleet_context_relay` event** with metadata `{trigger, topic, directive, relay_target, saurav_message_id}` — same shape as idempotency-at-call-site for external mutators, but in the comms domain.
2. **Send the relay carrier** (`cortextos bus send-message <orchestrator> high "<override summary>"`).
3. **Act on the directive** (config edit, restart, etc).
4. **Confirm to Saurav** with what was done.

Order: log → relay → act → confirm. Acting before relaying creates a window where boss is operating on outdated assumptions.

## Rule of thumb

Saurav-direct DMs to specialists are LIVE user surfaces — clarification + audit channels even when boss-dispatch is the primary work surface. Default to fire-relay-on-borderline; the asymmetric cost favors over-firing (bus volume is cheap; missed policy is expensive).

## Source incident

Micro-retro 2026-05-08 — analyst received Saurav-direct DM "dont suppress - i want to be able to speak to each agent directly as well as through boss - ensure u let boss know" reverting a fleet-config decision. Analyst edited configs, sent boss high-priority message, confirmed to Saurav — but did NOT log `fleet_context_relay` event in real-time. Logged retroactively with `retroactive: true` flag. The act-then-relay order meant boss was briefly operating on outdated assumptions. Audit lane caught it via boss's flag; rule formalized.
