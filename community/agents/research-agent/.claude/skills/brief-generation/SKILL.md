---
name: brief-generation
description: "Generate source-backed markdown briefs and run summaries for selected research signals."
---

# Brief Generation

Write a structured markdown brief for each selected signal.

---

## When to Use

After signal-scoring selects the top N items.

---

## Input

- `research/output/YYYY-MM-DD/signals-selected.json`
- `config.json` (for voice, audience, output folder)

## Output

- `research/output/YYYY-MM-DD/briefs/SLUG.md` (one file per selected signal)
- `research/output/YYYY-MM-DD/summary.md` (run summary across all briefs)

---

## Brief Format

Each brief file follows this structure:

```markdown
# [TITLE]

**Date:** YYYY-MM-DD
**Source:** [source_name] -- [url]
**Author/Channel/Repo:** [author]
**Category:** [category] | [funnel_stage] | [output_type]
**Score:** [score]/10

---

## Executive Summary

2-3 sentences. What is this? Why does it matter right now?

---

## Evidence and Proof Points

- Specific facts, numbers, dates, quotes from the source
- Raw metrics: stars, views, engagement, score
- Growth signals if applicable

---

## Technical Details

What is technically happening here? Relevant for builders and technical audiences.
(Skip or condense for non-technical signals.)

---

## Why It Matters

1-3 concrete reasons this is worth paying attention to.
Tied to the configured target audience and niche.

---

## Content Angles

- [Angle 1]: one sentence describing the hook or frame
- [Angle 2]: ...
- [Angle 3]: ...

Include at least 2, up to 5.

---

## Suggested Hooks

> "Quote or opening line that could start a piece of content"
> "Alternative hook"

---

## Recommended Action

One of: create content, investigate further, share internally, monitor, no action needed.
One sentence explaining why.

---

## Confidence and Freshness

- **Confidence:** high / medium / low (based on source quality and completeness of data)
- **Freshness:** [published_at] -- [N days old]
- **Shelf life:** [urgency score interpretation: breaking / 24h / 1 week / evergreen]
```

---

## Writing Rules

- Lead with the finding, not the process.
- Use the voice and audience defined in config (e.g. "technical founders building with AI" vs "content creators").
- Proof points must come from the source. Do not add claims not supported by the fetched data.
- Content angles must be specific. "Here's a content angle" is not a content angle. "The security incident shows that centralizing OAuth tokens at a vendor is an architectural liability -- frame as why to own your credential layer" is a content angle.
- If a brief cannot be written with enough evidence (source returned only a title), mark confidence as `low` and note what additional research is needed.

---

## Run Summary Format

`research/output/YYYY-MM-DD/summary.md`:

```markdown
# Research Run Summary -- YYYY-MM-DD HH:MM UTC

**Sources checked:** N
**Items collected:** N
**Items after dedup:** N
**Items scored:** N
**Items selected:** N (threshold: X, top_n: Y)
**Source failures:** list any

---

## Selected Signals

| # | Title | Score | Category | Output Type | Brief |
|---|-------|-------|----------|-------------|-------|
| 1 | [title] | 8.2 | [cat] | short_form_video | [briefs/slug.md] |
| 2 | ... | | | | |

---

## Source Performance

| Source | Items | Status |
|--------|-------|--------|
| github_trending | 25 | ok |
| reddit/r/community | 10 | ok |
| youtube_rss/channel | 0 | timeout |

---

## Delivery Status

[pending approval / sent to DESTINATION at HH:MM / disabled]
```
