---
name: business-news-monitor
description: "Daily cron-driven scan of news/forums/social in a domain to surface market shifts, new competitors, regulatory changes, and net-new opportunities. Use when: running a scheduled daily/weekly news pass, or when an idea-grooming pass needs fresh signal. Domain config (sources, keywords, thresholds) lives in agent config."
---

# Business News Monitor

You scan the domain your agent operates in for **material shifts** that affect the agent's active work — competitor moves, regulatory changes, technology breakthroughs, new entrants, audience-behavior shifts. Output goes to a structured log that other skills (`idea-grooming` re-grill, planning convos) can read.

This is **not a news aggregator**. The output isn't "here are the day's headlines." It's "here are the 1-3 things in your domain that materially changed and why you care."

---

## Inputs (from agent config)

Read your agent's config for the domain overlay:

- `domains: [<list>]` — e.g. `[financial-newsletters, retail-investor-tools]` for fingers, `[perfumery, scent-design]` for Kevin's perfumer agent
- `news_sources: [<{name, url, kind}>]` — RSS feeds, subreddit URLs, newsletter archives, GitHub trending paths. Each entry has a `kind` (rss / html / subreddit / hn / etc.) so you know how to parse.
- `competitors: [<list>]` — known incumbents and direct comparables to track explicitly
- `keywords_critical: [<list>]` — phrases that should trigger an alert if they appear (e.g. "Mailchimp acquisition" for fingers, "Firmenich layoffs" for perfumer)
- `keywords_relevant: [<list>]` — phrases that should be surfaced if they appear (broader, lower bar)
- `output_path: <path>` — where the daily log gets written (typically `<vault>/Operating System/News Monitor/<YYYY-MM-DD>.md` or similar)

If domain config is missing, surface the gap to the operator and don't silently produce a generic scan.

---

## Output rubric

Every run produces ONE markdown file at `<output_path>/<YYYY-MM-DD>.md` with this shape:

```markdown
---
date: YYYY-MM-DD
domains: [<from config>]
sources_scanned: <N>
items_seen: <N>
items_kept: <N>
materiality_threshold: medium
---

# Domain news monitor — <date>

## Material shifts (the only section the operator NEEDS to read)

For each material item (cap at 5 — discipline matters):

### <One-line headline of the shift>

- **What changed:** 1-2 sentences, plain language
- **Why we care:** how it affects active work / pursue ideas / current strategy
- **Source:** <link>, <publication>, <date>
- **Confidence:** high | medium | low (how solid the signal is)
- **Suggested action:** flag a re-grill on idea X / update positioning / no action / investigate further

## Surface (interesting, not material)

Bullet list. 3-10 items. Headlines + 1-line takeaway each. No expansion. These are FYI, not action triggers.

## Quiet today

If the scan found nothing material, say so explicitly. "Quiet today" is a valid output. Do NOT manufacture materiality to fill the section.

## Sources scanned

Inline list of every source visited + count of items pulled. Lets the operator audit coverage.
```

---

## Materiality test

For every candidate item, ask:
1. **Does it affect a current pursue idea or active work?** If yes → material.
2. **Does it match a `keywords_critical` keyword?** If yes → material.
3. **Does it represent a new competitor entering the space?** If yes → material.
4. **Does it represent a regulatory or platform change (Apple, Mailchimp, Anthropic, etc.) that touches our stack?** If yes → material.
5. **Does it surface a net-new opportunity (new audience, new tech enabling X, new market emerging)?** If yes → material.

Otherwise → surface (not material).

**Hard cap: 5 material items per day.** If the day genuinely has more than 5 material shifts, that's worth a Telegram alert to the operator separately — drop the rest into surface.

---

## Anti-patterns (don't do)

- Don't surface yesterday's news. Each item must be net-new since the last run.
- Don't paraphrase headlines. Quote the source headline verbatim, then add the "what changed" interpretation.
- Don't make predictions. ("This will lead to X" is out of scope.) Stick to what changed and why we care.
- Don't pad. If only 2 things are material, output 2 items. Empty padding is noise.
- Don't paste raw source content. Parse, summarize, link. The output should be skimmable in 60 seconds.

---

## Cron pattern

Suggested cadence per domain:

- **Fast-moving domains** (financial markets, AI, crypto): daily, weekday morning before the operator's first session
- **Slow-moving domains** (perfumery, brand strategy, niche B2B): 2x/week

Cadence lives in the agent's cron config, not here. This skill just defines how the scan runs once invoked.

---

## Cross-skill links

- Material items with `Suggested action: flag a re-grill on idea X` should trigger `idea-grooming` to re-run on that idea
- The output log is also read by `multi-perspective-grilling` when generating new perspectives on existing strategy
