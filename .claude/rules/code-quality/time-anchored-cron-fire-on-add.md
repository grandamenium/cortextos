---
domain: [cortextos-config, daemon]
applies_to: [engineer, analyst, boss]
severity: should-know
---

# Time-anchored cron add-cron fires once on registration; update-cron does NOT

**Two distinct daemon bugs in the same neighborhood.** `add-cron $AGENT $name "<cron-expr>" "<prompt>"` triggers an immediate fire of the prompt at registration time, then settles into the scheduled cadence. `update-cron --interval` modifies the schedule without firing immediately.

## Pattern fix

- Register time-anchored crons in batch outside daily windows where the immediate fire is acceptable noise.
- For in-flight adjustments, prefer `update-cron` over `remove-cron + add-cron` to avoid the spurious fire.

## Rule of thumb

If you're adding a time-anchored cron during an agent's working window, expect one spurious fire of the prompt — handle it idempotently or accept the noise. The two bugs are independent — fixing fire-on-add doesn't fix the SGT-as-local TZ bug, and vice versa.

## Source incident

Micro-retro 2026-05-05 — analyst registered theta-wave + daily-brief + kb-refresh + weekly-improvement during onboarding; got 3 unwanted fires immediately. Catalogued empirically across 4 update-cron calls on 2026-05-08. Distinct from the skip-next-fire-on-update bug previously mistaken for the same cause.
