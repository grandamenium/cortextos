# Scoring Model

Signals are scored using `research/scoring-rubric.json`.

## Components

- base engagement: normalized platform metrics
- fit: match to niche and audience terms
- velocity: metric growth across snapshots
- source-type bonus: platform/source relevance
- keyword boosts: configured terms
- negative keywords: filters or penalties

## Selection Rules

1. Load recent rows from `items`.
2. Join only the latest row from `metric_snapshots` for base engagement.
3. Compute velocity from earliest to latest metric snapshot.
4. Compute relevance, content fit, novelty, and combined score.
5. Record the result in `item_scores`.
6. Deduplicate near-identical topics.
7. Limit over-representation from one source family.
8. Suppress recently delivered items unless there is a resurfacing reason.
9. Drop items below threshold and select top N.
10. Do not set `delivered_at` or delivered state until delivery succeeds.

## Reason Codes

Store reason codes with scores so the user can understand why a signal was selected:

- `new_item`
- `velocity_spike`
- `workflow_tutorial`
- `repo_proof`
- `security_warning`
- `market_shift`
- `audience_fit`
- `source_quality`

## Tuning

If briefs are noisy, tighten niche terms, add negative keywords, raise minimum score, or remove noisy sources. If briefs are sparse, lower threshold, broaden sources, or reduce penalties.
