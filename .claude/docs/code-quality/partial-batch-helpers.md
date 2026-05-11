---
domain: [error-handling, api-design]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Best-effort batch creators must be checked at the call boundary

**Helpers that "create N things, return what we got" silently leak partial state when callers assume success implies completeness.**

## Pattern fix

Either:
- **Helper raises/returns null on partial completion**: `createBatch()` throws `PartialBatchError` if any item failed; caller deals with it explicitly.
- **OR caller checks at boundary**: `if (out.length !== EXPECTED) bail`.

Don't return half a structure and pretend it's whole. The `Promise.allSettled`-style "here's what happened" pattern is fine — but the CALLER must inspect the array and decide whether to continue. Silent partial-success is the bug.

## Rule of thumb

If your helper's return type is `T[]` and the function name implies "create all of these," you've designed an undefined-behavior contract. Either tighten the type to `BatchResult { successes, failures }` or fail loudly.
