---
domain: [external-mutators, retries, distributed-systems]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Functions that mutate external systems must be guarded by an upstream idempotency check

**A retry, a partial-write recovery, or a manual re-invocation will create duplicates unless the caller checks "is the work already done?" first.**

## Pattern fix

- **Sentinel field in local state gates the write.** Before calling external API, check local state: "did I already do this?" If yes, skip.
- **Push the gate to the call site where local truth lives** — don't try to make the writer itself idempotent across all upstream APIs (Todoist, GitHub, GWS each have different idempotency semantics; you can't normalize them).
- Same shape applies in the comms domain: `fleet_context_relay` event log is the local truth-of-record; the relay-message is the carrier.

## Rule of thumb

External mutators are not idempotent unless YOU make them idempotent. Every external write needs a "did I already do this?" check at the call site. The sentinel is local-state-shaped, not API-shaped.
