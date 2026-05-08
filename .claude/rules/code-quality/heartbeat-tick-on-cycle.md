---
domain: [reliability, observability, heartbeats]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# Heartbeat fields tick on every cycle, not only on activity

**A `last_poll` / `last_seen` that only updates when work happens is a *usage* signal, not a *liveness* signal.** Idle agents look dead.

## Pattern fix

Either:
- Rename to make it honest: `last_activity_at` (semantically correct, ambiguous about liveness).
- OR write on every cycle regardless of activity: `last_heartbeat_at = now()` every iteration of the loop, independent of whether work was done.

## Rule of thumb

If your "is it alive?" check is "did it do something recently?", you're conflating liveness with usage. Liveness needs a tick on every cycle, not only on activity.
