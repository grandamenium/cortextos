# Error Handling

How the research agent behaves when things go wrong. The design principle: degrade gracefully, never silently.

## Source Failures

### Single source unreachable
- Skip it. Log the failure with timestamp and HTTP status.
- Continue with remaining sources.
- Note in the run summary: "X of Y sources returned data."
- If it's a primary source (>30% of normal signal volume), flag in the brief header.

### Majority of sources unreachable (>50%)
- Abort the run. Do not generate a brief from thin data.
- Write a local failure summary. Notify the delivery target only if approval settings allow operational alerts.
- Log event: `source_majority_failure`.
- Retry once after 60 minutes. If still >50% down, escalate to human.

### Auth / credential failure
- Stop immediately. Do not retry with bad credentials -- it can trigger rate limits or lockouts.
- Notify human: "Credential failure for [source]. Run paused."
- Log event: `credential_failure` with source name.

### Rate limit hit
- Back off exponentially: 2m -> 8m -> 30m -> 1h.
- After 4 retries, skip the source for this run. Log: `rate_limit_skip`.
- Do not surface rate limit errors to end recipients.

## Scoring Failures

### No items score above threshold
- Do not fabricate items or lower the threshold silently.
- Send a null brief: "No items met the quality threshold this cycle."
- Log event: `null_brief` with cycle date.

### Scoring model unavailable (LLM API down)
- Fall back to keyword-match scoring only if configured.
- Clearly label the brief: "Scored via keyword fallback -- LLM unavailable."
- If no fallback configured, abort and notify.

## Delivery Failures

### Delivery target unreachable
- Retry 3 times with 5-minute intervals.
- After 3 failures, write the summary to `research/output/YYYY-MM-DD/DELIVERY-FAILED-summary.md`.
- Log the fallback path and notify via any secondary channel if configured.

### Duplicate delivery detected
- If a brief for this cycle date already exists at the delivery target, skip send.
- Log: `duplicate_delivery_skipped`.
- Do not overwrite existing briefs without explicit human instruction.

## Logging

All error events are appended to `research/output/YYYY-MM-DD/run.log` as structured lines:

```
[2026-05-27T22:00:00Z] ERROR source_failure source=reddit/YourSubreddit detail="HTTP 503"
[2026-05-27T22:00:01Z] ERROR delivery_failure attempt=1 detail="connection timeout"
[2026-05-27T22:05:01Z] ERROR delivery_failure attempt=2 detail="connection timeout"
[2026-05-27T22:10:01Z] ERROR delivery_fallback path="research/output/2026-05-27/DELIVERY-FAILED-summary.md"
```

Event types: `source_failure`, `source_majority_failure`, `credential_failure`, `rate_limit_skip`, `null_brief`, `delivery_failure`, `delivery_fallback`, `duplicate_delivery_skipped`.

## Escalation Path

| Condition | Action |
|-----------|--------|
| Single source down | Log only |
| Primary source down | Flag in brief header |
| Majority sources down | Abort + notify human |
| Credential failure | Abort + notify human immediately |
| 3+ consecutive null briefs | Notify human |
| Delivery failure after 3 retries | Fallback write + notify |
