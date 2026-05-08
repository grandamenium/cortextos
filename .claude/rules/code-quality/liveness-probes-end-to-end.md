---
domain: [reliability, monitoring, observability]
applies_to: [engineer, devops, analyst]
severity: blocker
---

# Liveness probes must be falsifiable end-to-end, not just structurally

**"Running with right name and count" doesn't prove it's *doing what it should*.** A daemon can be running but stuck; an agent can be alive but unresponsive.

## Pattern fix

Add a loopback probe that emits a sentinel from outside and verifies arrival. Examples:
- Send a no-op message via the bus, expect a no-op ACK within N seconds.
- Write a tracer file in a watched dir, expect the watcher to log "saw tracer" within N seconds.
- Drop a sentinel cron, expect the cron-fire log to record it.

Outbound success without inbound verification is the most common silent-failure shape.

## Rule of thumb

"Process exists with the right name" is a weak liveness signal. The strong signal is "system processed a sentinel I just sent." Build the loopback.
