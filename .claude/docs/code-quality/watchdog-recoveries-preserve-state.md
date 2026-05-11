---
domain: [reliability, restarts, supervisors]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# Watchdog recoveries preserve user state by default

**Default to `--continue` / `resume=true`** when a watchdog restarts a process. The restart-attempt cap prevents resume-loops if the session itself crashes.

## Pattern fix

Marker-files are for *intentional* sticky-resume only (model switch, handoff, explicit restart-fresh request). Default path:
1. Watchdog detects crash.
2. Increment crash counter.
3. If under cap: respawn with `--continue` / `resume=true`.
4. If over cap: respawn fresh, log warning, alert operator.

## Rule of thumb

User state is expensive to recreate; respawning fresh is the destructive option. Default to preserve, escalate to fresh only when preserve has demonstrably failed (crash-loop cap exceeded).
