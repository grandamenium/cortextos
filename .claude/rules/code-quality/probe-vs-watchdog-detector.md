---
domain: [reliability, monitoring, health-checks]
applies_to: [engineer, devops, analyst]
severity: blocker
---

# A probe and the recovery action it implies must share one detector function

**Reliability code typically grows two sibling check sites: (a) a probe that *reports* failure ("X is broken — restart needed") and (b) a health check called by the watchdog that decides *whether to restart*.** When both are written by hand from the same intent, they drift. Probe says "broken"; watchdog says "fine"; watchdog never acts on probe's alert.

## Pattern fix

Define one `isHealthy(): {ok: boolean, why: string}` per subsystem. The probe formats its message from that one return value; the watchdog reads `ok` from the same return value. They cannot disagree because they're the same code.

If you must keep them split (e.g., different processes), the test boundary is: for every probe, write a test that drives the recovery action against the same observable state and asserts the action also fires.

## Rule of thumb

Grep your codebase for the probe's error string. If you find a sibling function that branches on the same set of process counts / file states / API responses but doesn't trigger recovery for at least one state the probe flags, you have this bug.
