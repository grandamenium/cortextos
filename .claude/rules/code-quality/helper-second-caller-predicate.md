---
domain: [refactor, tests, predicate-design]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# When a helper gets a second caller, re-derive its predicate from first principles

**The full test suite often misses this because one existing test has codified the buggy behavior as the expected output — locked-in tests are not validation, they are version-controlled assumptions about a single caller's context.**

## Pattern fix

When adding a second consumer, audit:
- (a) the helper's predicate — does it still hold under the new context's invariants?
- (b) every test asserting on its output — was the expected output correct only for the original caller?

The moment a helper docstring needs the phrase "for X callers" or "in single-tenant mode" to stay accurate, the predicate is overfit to one caller.

## Rule of thumb

Reused helpers carry the assumptions of their first caller silently. Every new caller's invariants must be checked against the helper's predicate from scratch — locked-in tests don't substitute for re-derivation.
