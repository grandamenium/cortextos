---
domain: [networking, reliability, timeouts]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Long-poll connections need hard watchdogs

**A network library's `timeout: N` typically only covers connect + first-byte; once TCP is established, the timeout never fires on idle.**

## Pattern fix

Wrap loops in an outer deadline at 2-3x expected duration:
- Node: `AbortController` with `setTimeout` to abort the request.
- Python: `signal.alarm()` or `asyncio.wait_for(coro, timeout=...)`.

## Rule of thumb

If your network call hangs forever despite a configured timeout, you've hit a long-poll: TCP is open, no bytes flow, library timer never re-arms. Add an outer deadline regardless of what the library claims.
