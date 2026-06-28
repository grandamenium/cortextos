# Master Plan — spa-fetch.py v2 follow-link mode

**Owner:** larry (spec + review) → codexer (build) → scout (validate)
**Date:** 2026-06-18
**Framework:** one-big-feature (single cohesive feature, one file, backward-compatible)
**Target file:** `orgs/personal/agents/scout/scripts/spa-fetch.py` (scout's live runtime dir — git-ignored helper, NO PR; codexer edits in place, larry reviews diff, scout re-runs to validate)

## Goal
Add an opt-in `--follow-events` mode that bridges from a SPA-walled calendar landing page to per-event detail pages and extracts the fields hidden behind the SPA wall (cost, showtime, ticket_url, title). Driven by scout's comedy/cost hard rule: cost + advance-ticket-flag are required to surface a pick, and ~half the dogfood venues only expose cost on per-event pages.

## Non-negotiable constraints
- **Backward compatible:** without `--follow-events`, behavior is byte-identical to today. Zero regression risk to the existing daily dogfood.
- **Tab hygiene:** baseline tab count asserted pre/post; every per-event tab MUST `Page.close()`; mid-run drift → abort remaining hops, log offending host+slug, return partial.
- **No prod/Josh gate:** git-ignored helper in scout's dir. No PR, no main push.

## Larry's locked decisions (override the draft where they differ)
1. **Priority field = cost.** Extract all 4 fields on every followed page, but cost-bearing hosts (Heavy Manners / Whammy / Dynasty) are followed first, and a missing `cost` logs loud (`WARN: <slug> cost MISSING (rule-gate)`).
2. **Cap = 5 events/host default; Heavy Manners pre-set to 8.** Per-host configurable via `max_follow_per_run` in HOST_HINTS. Events ordered by date proximity (closest first), remainder skipped.
3. **Output = JSONL.** Under an `EVENT_DETAILS:` header, emit ONE compact JSON object per event, one per line: `{"title":..,"url":..,"showtime":..,"cost":..,"ticket_url":..}`. Empty string for missing fields. Line-oriented so scout greps OR `json.loads` per line.

## Phases
1. CLI flag + mode branch (`--follow-events`), backward-compat guard.
2. HOST_HINTS extension: `event_link_selector`, `field_selectors{title,showtime,cost,ticket_url}`, `extra_wait_ms_per_event` (default 2000), `max_follow_per_run` (default 5; HM=8).
3. Follow-link orchestration: render landing → collect event detail links → date-proximity sort → fetch up to cap → extract fields → close tab each → append JSONL.
4. Tab hygiene + drift abort + failure-mode handling (404 skip / timeout skip / selector-miss empty+log).
5. Self-test against the 5 priority hosts (codexer verifies selectors).

## Acceptance (scout validates post-build)
- `--follow-events` vs Heavy Manners → 4590-line landing PLUS ≥5 JSONL EVENT_DETAILS lines.
- Tab count returns to baseline (in-helper assertion).
- `--follow-events` vs Dynasty Kate Berlant 6/18 → cost field populated.
- WITHOUT flag → output identical to current (regression gate).
- Force-404 one slug → run continues, WARN logged.

## Spec
See `03-specs/follow-link-spec.md` (canonical = scout's `outputs/v2-scope-follow-link-2026-06-18.md`, amended by Larry's 3 decisions above).

---

## v2.1 increment — host-normalization fix (2026-06-20)

After scout's first clean v2 dogfood, 4 hosts (Whammy / AC-LF3 / Vidiots / Zebulon) yielded 0 EVENT_DETAILS. Larry diagnosed via live DOM + live helper runs (bridge :9333):

- **REAL bug:** host lookup keeps the `www.` prefix, so `HOST_HINTS.get("www.<host>")` misses → empty HINT → `event_link_selector=None` → silent 0-yield. Hits Whammy + AC-LF3 (scout passes www URLs). PROVEN: non-www Whammy → 4 events w/ cost; non-www AC-LF3 → 5 events w/ full fields.
- **Fix:** strip leading `www.` before the HOST_HINTS lookup in `normalize_url` (L121) + `build_browser_script` (L154) + the americancinematheque special-case (L124). ~3 lines. Lookup-key only — do not mutate the fetched URL.
- **Vidiots:** NOT a www bug (already bare); calendar is a Filmbot widget with no per-film anchors → deferred to v2.2.
- **Zebulon:** follow-link N/A by design (cost on landing) → no change.

Spec: `03-specs/selector-tune-v2.1-spec.md`. Owner flow unchanged (larry spec → codexer build in place → larry review → scout validate). No PR (git-ignored helper).
