---
domain: [refactor, feature-flags, primitives]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# When a new mode bypasses a primitive, audit every consumer of that primitive's "absent/false" state

**A new mode that opts out of an underlying mechanism silently breaks consumers that previously read the primitive's missing-or-false signal as a load-bearing semantic event.**

## Pattern fix

When adding a mode that opts out of a primitive:
- Grep for every site that reads the primitive's absent/false state.
- Add an explicit branch: `if (!primitiveAlive && !isInNewMode)`.
- OR widen the primitive: carry an explicit `mode` enum through the consumer.

NEVER reuse a code path designed for failure-of-the-primitive to mean "the primitive doesn't exist." A single boolean serving two domains needs to become two booleans, OR an enum, before the second consumer is added.

## Rule of thumb

A boolean's meaning is the union of all consumers reading it. Adding a mode that opts out without updating consumers means consumers now interpret your opt-out as their failure case. Audit consumers whenever you split a primitive's domain.
