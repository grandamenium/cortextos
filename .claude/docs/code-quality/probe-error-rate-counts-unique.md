---
domain: [observability, monitoring]
applies_to: [analyst, engineer, devops]
severity: should-know
---

# Probe error rate counts unique failures, not raw events

**A single stuck probe firing every 5 min generates 12 errors/hr — masks systemic vs isolated.**

## Pattern fix

Count distinct failing specs (e.g. dedup by `(probe_id, target_id)` per hour) instead of raw event counts. The signal you want is "how many things are broken," not "how many alarms went off."

## Rule of thumb

If your monitor's failure count grows linearly with the probe interval, you're counting alarm volume, not broken-thing count. Dedup by failing entity per time bucket.
