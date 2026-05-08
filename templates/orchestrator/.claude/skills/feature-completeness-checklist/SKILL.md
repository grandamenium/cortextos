---
name: feature-completeness-checklist
description: "Anti-pattern catalog — the 12 ways features 'look complete' but aren't. Read before PR. Based on user feedback 2026-04-25: agents kept shipping features that passed PR review but failed user reality check. Each pattern has a reproducible test."
triggers: ["feature complete", "completeness check", "is this done", "ship ready", "user-level check"]
---

# Feature Completeness Checklist

> User feedback 2026-04-25: "I keep finding broken stuff after you say it's done."
>
> Root cause: agents check "does the code work" not "does the user experience work".
> This skill closes that gap. **Before** marking any feature complete, run all 12.

---

## The 12 Gaps

### 1. Data-Zero Trap — "The UI renders, but all values are 0"
**Pattern:** Feature ships, data pipeline is broken, UI faithfully displays the zeros.
**Example:** Terpenprofil section on product-detail shows Beta-Myrcen 0,00%, Limonen 0,00%, Linalool 0,00%, Trans-Caryophyllen 0,00% — because `product.terpenes` is null in DB and frontend defaults to 0.
**Test:** `body.matchAll(/0[,.]\d{0,2}\s*%/g).length > 3` on any data-heavy page → probably broken data. Either seed real data OR hide the section entirely with empty-state.
**Fix direction:** Never render 0-values as meaningful data. Either show "Noch keine Daten" OR skip the section.

### 2. Decorative-Only Tags — "Looks like a filter but isn't clickable"
**Pattern:** Category/type/genetics shown as pill-badges on detail page (Blüten / Hybrid / Ice Cream Cake) but no href — user can't click them to get back to catalog filtered by that value.
**Example:** `<span class="pill">Hybrid</span>` instead of `<Link href="/medizin/produkte?genetik=hybrid">Hybrid</Link>`
**Test:** `[...document.querySelectorAll('[class*=pill],[class*=tag]')].filter(el => !el.closest('a')).length > 0` → decorative pills exist
**Fix direction:** Every category/genetics/strain/brand pill on a detail page MUST link to the filtered overview. Interconnect catalog ↔ detail ↔ strain ↔ pharmacy.

### 3. One-Way Navigation — "You can get there but not back"
**Pattern:** Detail page links to strain but strain page doesn't link back to products containing it.
**Example:** `/medizin/sorten/london-pound-cake` has zero `<a href>` to products. But products have strain reference.
**Test:** For every N-to-N relationship in schema: does BOTH pages show the other direction?
**Fix direction:** If X has a `strainId`, Strain detail MUST show `{products.filter(p => p.strainId === this.id)}`.

### 4. Effects/Symptoms Listed But Not Clickable
**Pattern:** Strain shows "Positive Wirkungen: Entspannung, Euphorie, Schmerzlinderung" as plain text. User thinks "I need pain relief" — can't click "Schmerzlinderung" to find strains with that effect.
**Example:** Current phytomedic.de/sorten/* is all static text
**Fix:** Every effect/symptom/terpene/breeder/side-effect → clickable → opens `/medizin/sorten?effect=schmerzlinderung` filtered list.

### 5. Slugless URLs — "Shareable but ugly"
**Pattern:** Filter uses internal ID in URL.
**Example:** `/medizin/produkte?apotheke=nd72j51qpz2kq5nskzm7a6p4zh821edk` — opaque to user, bad SEO, unshareable.
**Test:** `URL.searchParams` values should be human-readable slugs (`?apotheke=farma-plus-aachen`).
**Fix:** Pharmacy/Manufacturer/Strain filters resolve slug→id server-side. URL stays clean.

### 6. Silent Filter — "Filtered but you can't tell"
**Pattern:** URL has `?apotheke=xxx` but page doesn't show "Filtered by: X" chip, no count difference visible, no Clear-button.
**Test:** `URL.searchParams.size > 0` → MUST have visible active-filter-indicator.
**Fix:** Filter chips row above results: "🏥 Farma-plus Aachen ✕" · "Hybrid ✕" · "[Clear all]".

### 7. No-CTA Lists — "Here's a list, now what?"
**Pattern:** Category/discovery page shows items without a business-action CTA.
**Example:** /medizin/arzt-finden shows 5 doctors but no "Termin buchen" / "Jetzt Konsultation starten" CTA above fold.
**Fix:** Every list page needs a prominent business-conversion CTA in the hero.

### 8. List-Without-Detail — "Preview only"
**Pattern:** List page exists but individual items have no detail route.
**Example:** /medizin/arzt-finden has 5 doctors but no `/medizin/arzt-finden/[slug]` with full profile, ratings, Termine.
**Test:** Click any list item. Does it go somewhere deeper? If no → incomplete.
**Fix:** Always pair `/foo` (list) with `/foo/[slug]` (detail).

### 9. Bars-Missing — "Just numbers where bars would tell"
**Pattern:** Progress-type data (THC%, CBD%, Terpenes, Ratings, Therapy Treue) shown as numbers, not visual bars/gauges.
**Test:** Percentages on detail pages should have matching `<progress>` or `<div class="bar">`.
**Fix:** Numbers + Bar + Label — the three together are readable. Numbers alone force math.

### 10. Terminology Drift — "Sorten vs Strains"
**Pattern:** Internal term doesn't match user's mental model / cannabis industry standard.
**Example:** "Sortendatenbank" is correct German but the cannabis community uses "Strains" globally. Brand positioning / SEO win.
**Fix:** Get user's preferred term upfront (via platform-director Telegram). Once decided, use it consistently: URL, heading, nav, breadcrumb.

### 11. Backend-Only Fixes Shipped Without Frontend Surface
**Pattern:** Schema/migration lands but UI still shows old behavior because components don't read the new field.
**Example:** Strain-schema gemerged (PR #94) but /medizin/sorten page query doesn't include strains table → shows 0.
**Test:** After a schema PR merges, navigate to every surface that should render the new data. Check each one.
**Fix:** Feature-branches bundle schema + query + UI together. Or file a follow-up immediately.

### 12. Merged-Is-Not-Shipped — "PR merged ≠ data live"
**Pattern:** Code path exists but data-seeds / admin-config / backfill-actions never run against prod.
**Example:** Doctor-seed PR merged but seed never executed against --prod Convex.
**Test:** After merge + deploy, check the live URL with Playwright Mode A. Not "does it compile" — "does the user see the thing".
**Fix:** Post-merge checklist: (a) deploy verified green, (b) migrations/seeds executed against --prod, (c) Playwright smoke test.

---

## Pre-Completion Checklist (for PRs touching user-facing features)

Before `cortextos bus complete-task`, walk through this:

```
[ ] 1. Data-Zero Trap — is every number/percentage on the page actually derived from data? Not default 0?
[ ] 2. Decorative-Only Tags — is every category/type/genetics pill on detail pages an <a> with href?
[ ] 3. One-Way Navigation — if X references Y, does Y detail page show X's that reference it?
[ ] 4. Effects/Symptoms Clickable — do tag lists filter the overview?
[ ] 5. Slugless URLs — are filter params human-readable slugs?
[ ] 6. Silent Filter — when URL has params, does the page show active-filter-chips?
[ ] 7. No-CTA Lists — does the list page have a business-conversion CTA?
[ ] 8. List-Without-Detail — does each list-item route to a detail page?
[ ] 9. Bars-Missing — do numeric ratios/percentages have matching visual bars?
[ ] 10. Terminology Drift — does terminology match user's preferred wording?
[ ] 11. Backend-Only Fix — does the schema change have corresponding frontend usage?
[ ] 12. Merged-Is-Not-Shipped — ran seed/migration against --prod AND verified live URL?
```

If ANY of these is unchecked, the feature is not complete. File follow-up task, don't mark done.

---

## Integration with other skills

- Runs **after** `think-before-implementing` (which focuses on up-front planning)
- Runs **before** `pr-review-loop` (so fix before Greptile sees)
- Runs **before** `complete-task` call (last gate)

---

## How agents should learn from this

- When you find a 13th anti-pattern in the wild: add a row here with Example + Test + Fix.
- When a Greptile review catches something this skill missed: add the pattern.
- This file gets smarter every sprint.

---

*Single source of truth for "is this feature actually done".*
