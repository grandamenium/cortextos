# Spec — spa-fetch.py v2 follow-link mode

**Canonical source:** `orgs/personal/agents/scout/outputs/v2-scope-follow-link-2026-06-18.md` (scout-authored, full detail). This file is the build-of-record amended by Larry's 3 locked decisions.

## File to edit
`orgs/personal/agents/scout/scripts/spa-fetch.py` — in place. Git-ignored, no PR. Diff returns to Larry for adversarial review before scout validates.

## CLI
- New flag `--follow-events` (boolean). Absent → byte-identical to current behavior (REGRESSION GATE).
- Present → render landing (as today) → collect event detail links → date-proximity sort → fetch up to per-host cap → extract fields → close each tab → append `EVENT_DETAILS:` JSONL block.

## HOST_HINTS extension (per host)
```
"event_link_selector": "<CSS for event detail links on landing>",
"field_selectors": { "title": "<CSS>", "showtime": "<CSS>", "cost": "<CSS>", "ticket_url": "<CSS or attr>" },
"extra_wait_ms_per_event": 2000,
"max_follow_per_run": 5          # Heavy Manners = 8
```
Priority hosts (codexer verifies selectors): Heavy Manners (heavymannerslibrary.com/events/<slug>, cap 8) → Whammy (whammyanalog.com/event/<slug>) → Dynasty (dynastytypewriter.com/event/<slug>) → Vidiots (vidiotsfoundation.org/film/<slug>) → AC Los Feliz 3 (americancinematheque.com/now-showing/<slug>). Cost-bearing hosts (HM/Whammy/Dynasty) follow FIRST.

## Fields (all 4 every page)
`title, showtime, cost, ticket_url` (ticket_url absolute). Missing → empty string. Missing `cost` logs loud: `WARN: <slug> cost MISSING (rule-gate)`.

## Output (Larry decision c)
```
EVENT_DETAILS:
{"title":"Kate Berlant","url":"https://dynastytypewriter.com/event/kate-berlant-jun-18","showtime":"7:00pm","cost":"$30 adv / $35 door","ticket_url":"https://tixr.com/..."}
{"title":"Clothed Figure Drawing","url":"https://heavymannerslibrary.com/events/...","showtime":"6:00pm","cost":"$25 ($20 members)","ticket_url":"https://..."}
```
One compact JSON object per event, one per line. grep-friendly + json.loads-able.

## Caps & ordering (Larry decision b)
`max_follow_per_run` default 5, HM=8, per-host configurable. Order by date proximity (closest upcoming first); remainder skipped.

## Tab hygiene (non-negotiable)
Baseline count pre-run; assert post-run returns to baseline. Every per-event tab `Page.close()` after extraction. Mid-run drift → abort remaining hops, log offending host+slug, return partial output.

## Failure modes
- Per-event 404 → skip, `WARN: <slug> 404 skipped`
- Per-event timeout → skip, `WARN: <slug> timeout @<wait_ms>ms`
- Field selector empty/no-match → empty value, `WARN: <slug> field <name> selector miss` (do NOT abort event/run)

## Out of scope
>1 hop, login/auth, image extraction, non-event links, multi-language.

## Acceptance (scout validates)
1. `--follow-events` vs Heavy Manners → 4590-line landing PLUS ≥5 EVENT_DETAILS JSONL lines, cost populated where exposed.
2. `--follow-events` vs Dynasty Kate Berlant 6/18 → cost field surfaces (marquee cost-gate test).
3. Tab count returns to baseline (in-helper assertion).
4. No-flag run (Vidiots or Zebulon) → output identical to today.
5. Force-404 a slug → run continues, WARN logged.
