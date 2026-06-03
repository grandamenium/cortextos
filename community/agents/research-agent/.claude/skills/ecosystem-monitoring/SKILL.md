---
name: ecosystem-monitoring
description: "Monitor vendor, competitor, market, and technical ecosystem sources and summarize what changed, why it matters, and what to do."
---

# Ecosystem Monitoring

Use this skill for recurring market or technology monitoring beyond a single daily signal run.

## What to Monitor

Configure relevant sources in `research/sources.json`:

- vendor blogs and release notes
- GitHub repos and releases
- Hacker News / Reddit discussions
- arXiv and research feeds
- competitor websites or changelogs
- public status pages
- community or social signals if configured

## Output

Write ecosystem digests under:

```text
research/output/YYYY-MM-DD/ecosystem.md
```

## Digest Format

```markdown
# Ecosystem Digest -- YYYY-MM-DD

## What Changed
- [Source]: [change]

## Why It Matters
- [Impact for the user's niche/audience]

## Evidence
- [URL/title/date/metric]

## Opportunities
- [Content, product, research, sales, or operational opportunity]

## Risks / Caveats
- [Uncertain, weak, or conflicting evidence]

## Recommended Actions
- [Monitor / brief / investigate / ignore / create content / update product]
```

## Alert Thresholds

Surface immediately when configured:

- core vendor outage or breaking change
- competitor launch or pricing/positioning shift
- fast-rising repo in the user's territory
- new research result with direct practical relevance
- repeated community complaint or request pattern

## Rules

- Prefer primary sources.
- Label inference separately from sourced facts.
- Do not include private or auth-only data in public-facing summaries.
- Keep links with claims.
