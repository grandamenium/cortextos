---
name: bug-hunter-mindset
description: "Permanent stance for systems-analyst: assume the website is never good enough. Run autonomous exploration sessions every 4h. Hunt bugs, missing features, cross-page incoherence. File task per finding. Per user directive 2026-04-25: 'denken die webseite ist nicht gut genug. selbstständig gucken'."
triggers: ["bug hunt", "explore prod", "find issues", "user simulation", "what's missing"]
---

# Bug Hunter Mindset

> User directive 2026-04-25: "selbständig weiter nach bugs suchen und immer
> denken die webseite ist nicht gut genug. selbstständig gucken was der
> nutzer für features gebrauchen könnte"
>
> Translation: be the user's paranoid friend who tries to break things and
> notices what's missing. Run this every 4h. Forever.

---

## Stance

The website is broken until proven otherwise. Every page has at least one issue.
Your job is finding it before the user does. If a session ends with "everything
looked fine", you didn't look hard enough. Look in:

- Edge data (very long names, very small numbers, missing fields, special chars)
- Edge devices (375px mobile, 1920px desktop, dark mode if exists)
- Edge users (signed-out, signed-in, admin, doctor)
- Edge flows (back-button mid-flow, refresh, two tabs concurrent, slow network)
- Edge time (right after deploy, right after migration, weekend)

---

## Hunt protocol — 30 minutes per session

### Phase 1: Pick a target (3 min)

Rotate through these. Skip what was hunted in the last 2 cycles (memory.md log).

| # | Target | Hunt-focus |
|---|--------|-----------|
| 1 | Public landing + /medizin hub + /eignungstest | Conversion friction, broken CTAs |
| 2 | Catalog + filters + first-page products | Filter combinations, sort, pagination |
| 3 | Random product detail (pick one) | Tabs, terpenes, related, cross-links |
| 4 | Strain hub + random strain detail | Lineage, related products, effects-as-filters |
| 5 | Doctor finder + single doctor detail | CTA, booking, profile completeness |
| 6 | Pharmacy finder + single pharmacy detail | Delivery options, products at pharmacy |
| 7 | Cart → Checkout 5 steps | Order summary persistence, costs transparent |
| 8 | Login + Register + Onboarding flows | Brand voice, German consistency, validation |
| 9 | Wissen + Krankheiten content discovery | Article-to-product cross-links |
| 10 | Patient dashboard (login as patient) | Widget data, broken charts, empty states |
| 11 | Doctor dashboard | Same |
| 12 | Pharmacy dashboard | Same — also multi-tenancy: confirm only own data visible |
| 13 | Manufacturer dashboard | Same |
| 14 | Admin dashboard | Same |

### Phase 2: Explore deeply (20 min)

For the chosen target, run:

```
1. browser_navigate
2. browser_snapshot (read accessibility tree)
3. browser_console_messages level=error → log all
4. browser_network_requests static=false → log all 4xx/5xx
5. browser_evaluate run quick-scan:
   - body has /undefined|NaN|0[,.]00\s*%|lorem|TODO|\[.*ergänzt\]/
   - title.match(/PhytoMedic/g).length > 1
   - all images.naturalWidth > 0
   - decorative pills (find <span> with no closest('a') that look like tags)
   - URL params without active-filter-chip rendered
   - clickable-looking elements with no href and no onclick
6. browser_take_screenshot fullPage=true → save to tests/e2e/reports/hunt-YYYY-MM-DD/
7. Click the first 3 interactive elements you haven't clicked. Check resulting page.
8. Resize to 375x667 (mobile) → screenshot again → check overflow/wrap issues
9. If form on page: try empty submit, very long input, special chars, unicode emoji
10. If list on page: verify pagination/infinite-scroll/total-count
```

### Phase 3: File findings (5 min)

For each finding, file a task with reproducible steps:

```bash
cortextos bus create-task "[HUNT-YYYYMMDD-NN] <title>" --desc "Found by autonomous hunt $(date).

URL: <full URL>
Viewport: <desktop|mobile>
Repro:
1. <step>
2. <step>
3. <step>

Expected: <what should happen>
Actual: <what happens>

Anti-Pattern (from feature-completeness-checklist): #<number> <name>
Console errors: <list or none>
Network failures: <list or none>
Screenshot: tests/e2e/reports/hunt-YYYY-MM-DD/<file>" \
  --assignee <auto-route based on issue type> \
  --priority <urgent|high|normal|low based on impact>
```

Auto-routing:
- UI / layout / decorative / interactivity → frontend-dev
- Data missing / 0% / empty list → integrations-routing OR cannametrics-data
- Auth / API / backend logic → backend-architect
- Cross-cutting / strategy → platform-director
- Sensitive (security, legal) → escalate to user via platform-director

### Phase 4: Memory + handoff (2 min)

```bash
# Log this hunt for next cycle's rotation
echo "$(date -Iseconds) target=$TARGET findings=$N" >> memory/hunt-log.md

# Update heartbeat
cortextos bus update-heartbeat "bug-hunt completed: target=$TARGET, $N findings filed"

# If 0 findings: dig deeper next time, not "all clear"
```

---

## Cross-page coherence checks (do once per hunt)

The user said: "immer prüfen ob alles notwendige zusammenhängt anhand der ganzen seiten und dashboards die es gibt".

**Map of relationships to check:**

```
Product detail
  ↔ Catalog filter (kategorie, genetik, hersteller)
  ↔ Strain detail (strainId)
  ↔ Pharmacy filter (pharmacy that sells it)
  ↔ Manufacturer profile

Strain detail
  ↔ Catalog filtered by strain
  ↔ Sister-strains (same parent)
  ↔ Effects → Strain-overview filtered by effect
  ↔ Doctors who prescribe this strain (anonymized aggregate)

Pharmacy
  ↔ Products at pharmacy (catalog filter)
  ↔ Pharmacy on map
  ↔ Pharmacy reviews (if exists)
  ↔ Pharmacy delivery info → checkout summary

Doctor
  ↔ Doctor dashboard for that user
  ↔ Patient reviews
  ↔ Doctor's prescriptions (admin only)
  ↔ "Termin buchen" CTA

Cart item
  ↔ Product detail
  ↔ Pharmacy that fulfills
  ↔ Order in patient dashboard
  ↔ Prescription in doctor dashboard
  ↔ Pharmacy order in pharmacy dashboard
  ↔ Stripe payment + Cannaflow payment + invoice
```

For your hunt target, pick 2 relationships and verify both directions work.
File a task if any direction is broken (one-way navigation = Anti-Pattern #3).

---

## Proactive feature suggestions

The user said: "selbstständig gucken was der nutzer für features gebrauchen könnte".

After each hunt, write 1 feature suggestion to `tests/e2e/reports/feature-suggestions/$(date +%Y-%m-%d).md`:

Format:
```markdown
## YYYY-MM-DD HH:MM — <Feature suggestion title>

**Trigger:** What user pain point did I notice?
**Suggestion:** What feature would solve it?
**Effort estimate:** S/M/L/XL
**Impact:** S/M/L/XL  
**Reference:** Industry comparison (similar feature on flowzz.com / shop-apotheke.com / amazon)
**Open question for user:** <if anything needs decision>
```

Once per week, platform-director consolidates these into a "Feature Wishlist" Telegram digest to user.

---

## Calibration: severity heuristics

| Finding | Priority |
|---------|----------|
| Broken auth / data leak / payment fails | URGENT |
| Empty-state on critical page (catalog, checkout) | URGENT |
| Wrong amount / wrong product / wrong recipient | URGENT |
| Missing CTA on conversion page | HIGH |
| Missing detail page for listing | HIGH |
| Decorative-only tags / one-way navigation | HIGH |
| Mobile layout broken | HIGH |
| Console error (non-fatal) | NORMAL |
| Slow load (LCP > 4s) | NORMAL |
| Typo / inconsistent capitalization | LOW |
| Pixel-perfect layout nit | LOW |

---

## Anti-Pattern: "All clear" reports

A hunt that finds 0 issues is suspicious. Re-run with deeper exploration:
- Try a path you've never tried
- Try with empty data / max data
- Try with adversarial input
- Try with auth flipped (signed-out vs in)

If after deepened hunt still 0 issues: file ONE feature-suggestion-task to compensate
("things that AREN'T bugs but could be better"). Never end a hunt with literally nothing.

---

## Schedule

```json
{
  "name": "bug-hunter-cycle",
  "interval": "4h",
  "prompt": "Read .claude/skills/bug-hunter-mindset/SKILL.md and execute one full hunt cycle (target rotation, exploration, file findings, memory log, feature suggestion). 30 min budget."
}
```

Runs 6× per day. Targets rotate (14 targets, ~2 days for full rotation).

---

*The website is never good enough. Hunt forever.*
