---
domain: [cortextos-config, time, daemon]
applies_to: [engineer, analyst, boss]
severity: blocker
---

# Daemon SGT-as-local cron-schedule interpretation lies about UTC

**cortextOS daemon interprets cron expressions as Asia/Singapore local time and converts to UTC by subtracting 8h, but the schedule storage field looks like UTC and `list-crons` Next-Fire display claims UTC.** Three layers disagree: storage, display, execution. Result: `30 23 * * *` displays "next fire 23:30 UTC" but actually fires at 15:30 UTC.

## Pattern fix (canonicalization, the real fix)

Declare canonical TZ in `orgs/<org>/context.json`. Daemon resolves all schedule expressions in declared TZ. `list-crons` display shows both declared-TZ and computed-UTC explicitly.

## Temporary workaround until canonicalization ships

Encode cron expressions as `(target_UTC + 8) mod 24` in the hour field (e.g. to fire at 13:00 UTC, set `0 21 * * *`). Display will lie but execution will be correct.

**The `+8` encoding is temporary — it MUST be reverted atomically when the canonicalization PR ships.** See `orgs/sb-personal/agents/analyst/MEMORY.md` § "Canon PR Revert Coordination" for the cross-agent flip protocol; otherwise encoded crons + canonical daemon = double-correction (8h offset in the WRONG direction).

## Rule of thumb

When the daemon, the storage, and the display disagree on a TZ, the bug is canonicalization, not any one layer. Don't fix the surface; fix the source-of-truth. Validation set: `daemon_cron_misfire` warning event log — preserve through the canonicalization PR + 24h post-merge observation.

## Source incident

Micro-retros 2026-05-05 to 2026-05-08 — analyst caught the 8h offset across morning-review, evening-review, theta-wave, daily-brief, kb-refresh; first observation during analyst onboarding 2026-05-05 when time-anchored crons fired at registration time AND at SGT-converted UTC. Confirmed across 9 independent data points spanning 4 cron schedules over 4 days.
