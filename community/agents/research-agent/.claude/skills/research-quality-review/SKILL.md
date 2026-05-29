---
name: research-quality-review
description: "Audit source quality, scoring performance, duplicate patterns, source failures, stale config, and tuning opportunities."
---

# Research Quality Review

Run weekly, after a few research cycles, or whenever the briefs feel noisy.

## Inputs

- `research/output/`
- `research/topic-briefings/`
- `research/sources.json`
- `research/scoring-rubric.json`
- `research/db/signals.db` if available
- recent user feedback

## Review Checklist

1. Source failures:
   - repeated timeouts
   - rate limits
   - empty sources
   - auth failures
2. Source quality:
   - high-volume low-signal sources
   - sources that never produce selected items
   - missing source categories
3. Scoring quality:
   - obvious good signals below threshold
   - noisy signals above threshold
   - over-weighted platform bonuses
   - stale or too-broad keywords
4. Deduplication:
   - repeated same story across platforms
   - old items resurfacing without new evidence
5. Delivery quality:
   - too much detail in summaries
   - weak source attribution
   - unclear recommended actions
6. Topic briefing quality:
   - options too similar
   - low evidence topics
   - weak why-now framing

## Output

Write:

```text
research/output/YYYY-MM-DD/research-quality-review.md
```

Use this format:

```markdown
# Research Quality Review -- YYYY-MM-DD

## Summary
[What is working / not working.]

## Source Changes Recommended
- Keep:
- Add:
- Remove:
- Watch:

## Scoring Changes Recommended
- [Specific rubric edit and why]

## Workflow Changes Recommended
- [Cron, delivery, topic briefing, output format changes]

## Human Decisions Needed
- [Decision and tradeoff]
```

Do not edit source/scoring config automatically unless the user asks. Propose changes first.
