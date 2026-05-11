---
domain: [networking, reliability, timeouts]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Network-call timeouts must be sized to observed p99, not intuition

**Don't wrap a deterministically-too-short timeout in retry-once-after-Ns** — that mis-labels the deterministic failure as "transient flake" and misdirects diagnosis.

## Pattern fix

When a timeout is suspected:
1. Instrument with one direct uncatched call and *measure* the actual p99.
2. Set the timeout to ~2x measured p99.
3. If the call is genuinely flaky (variance > 3x), retry helps; if it's deterministically slow, retry is debt.

**Test fix:** mock the underlying call to inject a 1.1x-timeout-duration delay and assert the request succeeds (i.e., the timeout has margin).

## Rule of thumb

An error message that implies data corruption ("DB inconsistent", "state divergence") is a strong signal to FIRST verify it isn't really "client gave up before server finished" — picking dramatic error labels for benign causes hides root causes for years.
