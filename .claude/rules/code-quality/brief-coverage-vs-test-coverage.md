---
domain: [llm, ai-orchestration, tests]
applies_to: [engineer, devops, fullstack, boss]
severity: blocker
---

# LLM-worker self-evaluators only validate the code path their tests cover

**When the brief commits to multiple callers, the worker must drive each path end-to-end or the untested ones ship broken.** Brief coverage exceeds test coverage and the LLM worker doesn't notice.

## Pattern fix

In goal briefs that touch multiple callers/modes:
- "What done looks like" section MUST enumerate each caller path explicitly.
- "Verification suggestions" section MUST require at least one test that drives each.
- The planner that decomposes the brief MUST produce a separate task asserting integration on each caller.

## Rule of thumb

If your brief says "applies to X / Y / Z" but your unit-test suite only patches X, Y and Z are unverified and probably broken. Brief coverage is not test coverage; the planner must decompose into per-caller tests.
