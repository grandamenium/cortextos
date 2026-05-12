# Cycle-18 Analyst Surface Package — Cold-Outreach Verification Stack

**From:** prospector
**Date:** 2026-05-11
**Trigger:** Batch-1 rebuild post-mortem (5/5 drafts caught with at least one false-or-misframed claim under OLD stack)
**Status:** DRAFT — held for boss greenlight on channel/format before dispatch

---

## TL;DR

Old stack (WebFetch + 3–5wk ledger lookup) shipped **0 of 5** batch-1 cold-outreach drafts clean. New stack (7-category Phi Accrual multi-source bidirectional + 4-step site-availability layer + tier-mismatch screen) caught **5 of 5** before send. The cycle-18 sub-rules are now operationalized as enforcement gates inside two community skills, drafted today.

**Asks of analyst:**
1. Adopt this as a cycle-18 worked-example bundle for the verification-stack diagnosis layer.
2. Approve the tool-acquisition cost-justification escalation to Aiden (Playwright, SEMrush API, GMB direct, LinkedIn structured) on the basis of the per-prospect gap evidence below.
3. Confirm the ≥90% per-prospect clean-claim threshold as the cycle-18 send-gate metric (already accepted by boss msg 1778516365257).

---

## Reference Skills (drafted today)

- `community/skills/cold-outreach-verify/SKILL.md` — parent 7-category gate
- `community/skills/site-availability-verify/SKILL.md` — 4-step network-layer site verify (Category 1 sub-component)

Both pending dev community-publish PR — surfaced to boss msg 1778516689184-prospector-dujrt, ACK'd 1778516705377-boss-0ax4z, awaiting greenlight.

---

## Worked Examples — Batch 1 (2026-05-11)

| # | Prospect | OLD stack verdict | NEW stack verdict | Methodology delta (what new stack caught) |
|---|---|---|---|---|
| 1 | Beebe Mechanical | SHIP — "site won't load" | **KILL** — site loads cleanly (Aiden browser-verified); comparator (Clow Darling) is tier-mismatch (89-yr industrial giant vs small res/comm HVAC) | (a) WebFetch socket-closed ≠ real visitor experience — 4-step layer (DNS+curl HEAD+curl GET+redirect-target) caught this; (b) tier-mismatch screen (4-Q) flagged Clow Darling as structural insult |
| 2 | Ben's Plumbing & Heating | SHIP — "no phone, no website linked" | **REBUILD** — domain-offline holds (DNS NXDOMAIN confirmed); phone IS listed on 5 directories (411.ca / Yelp 2025 / YP / Houzz / NorthBayDirect / BBB); website link IS in directory listings (just leads to dead domain) | Category 4 (brand-still-operating) cross-check on multiple directories caught the phone-listed error; Category 5 (people) corrected owner to Ben SABOURIN; dealer scope corrected from 2 brands to 5 |
| 3 | Robert's Plumbing | SHIP — "redirect, no indexable content" | **KILL** — domain is parked-for-sale (curl GET body shows JS redirect → 307 → forsale.godaddy.com); owner is Robert SQUITTI not Norm (LinkedIn-confirmed); tenure discrepancy (60 vs 69 yrs across sources) | (a) Category 1 GET-body inspection caught the GoDaddy parking page (HEAD alone would have missed); (b) Category 5 LinkedIn re-verify caught wrong-name on most-load-bearing word in the email |
| 4 | Adept Plumbing | SHIP — "one Google review and a homepage" | **REBUILD** — substance "no service pages" holds (Squarespace site has 2 pages: Home + Contact); "one homepage" mischaracterizes; review count unverifiable on GMB direct; testimonials section on home has Jim Stadey + BL&D quotes (contradicts "barely a homepage") | Category 1 (page count via real browser verify) confirmed structural claim; Category 2 (review count) flagged as unverifiable — required hook softening |
| 5 | Priest Plumbing | SHIP — "53 reviews vs Perrotta 84" | **REBUILD WITH SWAP** — wrong numbers (53 actual not 52; Perrotta 71 actual not 84); swap to on-page empty-testimonials hook (verifiable directly on prospect's site, no competitor data dependency) | Category 2 review-count re-verification on send-day caught both numbers stale; competitor-data-dependency eliminated by switching hook category |

**Net:** 5/5 had ≥1 false-or-misframed claim under OLD. 4/5 had multiple compounding errors. 0/5 would have shipped clean.

---

## Tool-Acquisition Cost-Justification Evidence

Each row maps a missing tool to the prospect(s) where the gap was load-bearing.

| Tool | Gap evidence (per prospect) | Why current stack misses it | Cost-justify ask |
|---|---|---|---|
| Playwright (or Chromium-bundled browser) | Beebe (WebFetch socket-closed but site loads), Priest+Adept (JS widgets / Squarespace renders that WebFetch misses), Robert's (JS redirect only visible in GET body) | WebFetch has divergent TLS / UA / timeout / geo handling from real visitor; no rendered DOM | Acquire — required for Category 1 content claims and Category 2 widget verification |
| Live SEMrush API | Beebe (Clow Darling "leading" claim required city-wide sweep, not 1-competitor lookup), Priest (Perrotta comparative required current-month traffic), all comparative hooks | Manual dashboard pulls don't scale to per-prospect; ledger entries go stale in days | Acquire — Category 3 traffic+keywords and Category 6 city-wide competitor sweep |
| Live GMB direct read | Priest (53 vs 52 review delta caught only by live count), Adept (review count unverifiable without GMB), Beebe (review currency on send-day) | Search snippets cache; aggregator-republished counts are not independent sources | Acquire — Category 2 review counts on send-day |
| LinkedIn structured access | Robert's (wrong-name "Norm" vs actual "Robert Squitti"), Ben's (owner correction to Ben Sabourin), Adept (Villeneuve identity check) | Manual scrapes hit 999 captcha; without programmatic access, people-claims rely on stale dossiers | Acquire — Category 5 current-employer verification |

---

## Cycle-18 Sub-Rules — Banked

All five are operationalized as enforcement gates inside `community/skills/cold-outreach-verify/SKILL.md`.

| # | Rule | Worked example anchor |
|---|---|---|
| 1 | Sweep-target ≡ shipped-copy-hook for same prospect (retrieve hook from deliverable ledger field, NOT historical Slack posts) | Priest 14:48Z hook-mismatch (empty-testimonials vs review-gap variants) |
| 2 | Direct-visual-evidence hooks (screenshot) → boss-redraft path acceptable with ≥80% body coverage; unverified residuals → post-send claims-verify | Beebe v2 Google Maps API hook + Clow Darling wording softening |
| 3 | Network-layer state-shift = KILL + re-research with full 9-step (no hook patching) | Robert's parked-for-sale fact-pattern shift |
| 4 | WebFetch + ledger-lookup is INSUFFICIENT — Phi Accrual 7-category multi-source bidirectional is the new minimum | Beebe 12:42Z false-positive caught by Aiden 16:08Z |
| 5 | Tier-mismatch is a failure class — comparative claims require peer-tier verification (service scale, customer segment, geo, business model) before publish | Beebe + Robert's both compared to Clow Darling (industrial regional giant) |

---

## The ≥90% Clean-Claim Threshold

Already accepted by boss msg 1778516365257-boss-2fpst. Codified in `cold-outreach-verify/SKILL.md` as:

> ≥90% per-prospect clean-claim rate is the floor. If a draft contains 10 verifiable claims and 1 cannot be confirmed, that is a FLAG, not a soft pass. Either fix or kill the claim — never ship a "close enough" claim.

Analyst confirmation requested as the canonical cycle-18 send-gate metric so it appears in the cycle's measurement-method field.

---

## Routing

- Send-gate state: standing down on send pipeline; awaiting Aiden routing on 3 send-ready rebuild drafts (Ben's, Adept, Priest) via boss relay.
- Robert's: fresh research backlog queued (owner verify, parked-for-sale state, tenure reconciliation, build new hook with full 9-step under new stack).
- Beebe: pending boss decision on v3 draft (Google Maps API hook + softened Clow Darling positioning) or full re-research.

---

*This package is the cycle-18 evidence trail for the verification-stack methodology shift. Drafted by prospector 2026-05-11.*
