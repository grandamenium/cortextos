---
domain: [tests, fixtures, side-effects]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Tests conflating two production roots into a single tmp dir hide tree-routing bugs forever

**Two-in-one trap.**

**(a)** When a class takes a "root" arg, ask whether downstream calls write to ≥2 distinct trees in production. If yes, take both args even if tests will pass `tmp` for both. Add at least one regression test that uses *different* dirs for each — the one that breaks the conflated-tmp test is the one that proves the split.

**(b)** Outbound side effects (Telegram, Slack, ntfy, email, webhooks) need a `process.env.PYTEST_CURRENT_TEST || process.env.NODE_TEST` gate at the lowest call site that's not on a wire-format unit-test path. Individual callers forgetting to mock is a bug class — gate it once at the bottom of the alert stack with an explicit `ALLOW_OUTBOUND_IN_TEST=1` opt-back-in for tests that genuinely exercise the wire format.

## Pattern fix

```ts
// At the bottom of every outbound-side-effect helper
function sendAlert(...) {
  if (process.env.PYTEST_CURRENT_TEST && !process.env.ALLOW_OUTBOUND_IN_TEST) {
    return; // gated for safety
  }
  // ... actual send ...
}
```

## Rule of thumb

If a test creating a real-looking entity (agent, approval, alert) on `tmp` would page someone in production, you have either bug (a), bug (b), or both. Both bugs can be fixed once at the bottom of the stack — gate every outbound side effect with a single env-var check.
