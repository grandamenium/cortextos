---
domain: [state, distributed-systems, refactor]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Parallel state machines: cleanup must update the OTHER state machine through its API

**When two parallel state machines track the same entity, the cleanup-side must update the *other* one through its own API — not just kill the underlying resource.** Both sides being correct in isolation does not prevent disagreement when combined.

## Pattern fix

If you reuse another subsystem's spawn primitive (workers/, processes/, watchdog/), you also own updating its terminal state through its API on the way out. Don't just yank the resource out from under it.

Pseudocode pattern:
```ts
async function cleanup(entity) {
  await thisSystem.markTerminal(entity);
  await otherSystem.notifyTerminal(entity);  // <- the missing call
  killUnderlyingResource(entity);
}
```

## Rule of thumb

Parallel trackers go out of sync silently — both pass their own unit tests, the integration breaks at runtime. If two subsystems both write the entity's lifecycle, both must read the lifecycle's terminal events.
