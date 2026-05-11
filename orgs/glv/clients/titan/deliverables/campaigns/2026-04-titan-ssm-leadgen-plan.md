# Titan Tiny Homes — Ontario Lead Gen Campaign: Stage 2 Plan
**Prepared by:** GLV Marketing (ads agent)
**Date:** 2026-04-25
**Status:** DRAFT — pending Aiden approval before any spend or build
**Geo:** Ontario-wide (Aiden confirmed 2026-04-25)
**Stage 4 (implementation) gated on:** Meta Business Manager + Pixel for titantinyhomes.ca

---

## Campaign Overview

| Field | Detail |
|-------|--------|
| Client | Titan Tiny Homes (titantinyhomes.ca) |
| Objective | Lead generation — qualified buyers requesting pricing / consultation |
| Budget | $500 CAD/month ($16.67/day) |
| Duration | Ongoing — reviewed monthly |
| Audience | Ontario-wide, buyers interested in tiny homes / alternative housing |
| Geo | Ontario (all) — broad, no city exclusions |
| Ad format | Meta native lead forms |
| Campaign structure | 1 campaign (CBO), 2 ad sets — Broad + Downsizer test |
| Commission model | Aiden on per-lead/sale commission — maximize qualified lead volume |

---

## Campaign Structure

### Why 1 Campaign / 2 Ad Sets (Not More)

At $500/month ($16.67/day), splitting across more than 2 ad sets fragments the signal Meta's algorithm needs to exit the learning phase. Under Andromeda, creative is the primary targeting signal — the algorithm needs volume within a single ad set to find buyers, not narrow segments fighting for thin budget.

**Rule:** Don't add a 3rd ad set until monthly budget reaches $800+.

---

### Campaign: Titan Lead Gen — Ontario
**Type:** Campaign Budget Optimization (CBO)
**Daily budget:** $16.67/day ($500/mo)
**Objective:** Lead generation (Meta lead form completions)
**Bidding:** Lowest cost (default — let Meta optimize during learning phase)

---

### Ad Set A: Broad Ontario (Primary — ~70% of budget)
*Meta will auto-allocate ~$11–12/day here via CBO once it learns*

| Setting | Value |
|---------|-------|
| Geography | Ontario (all) |
| Age | 28–65 |
| Gender | All |
| Interests | None — true broad |
| Placements | Auto (FB feed, IG feed, Stories, Reels) |
| Expected CPL | $25–38 CAD |
| Creative load | 3–4 ads (Angles 1, 2, 4 from Stage 1) |

**Why broad?** Under Meta's Andromeda update, interest stacking actively hurts performance at Ontario scale. Creative self-selects the audience — our affordability hooks find first-time buyers, our lifestyle hooks find downsizers. The algorithm does the segmentation work.

---

### Ad Set B: Downsizer Lean (Secondary test — ~30% of budget)
*Meta will auto-allocate ~$4–5/day here via CBO; kill if CPL > $60 after $100 spend*

| Setting | Value |
|---------|-------|
| Geography | Ontario (all) |
| Age | All *(see compliance note below)* |
| Gender | All |
| Interests | `Minimalism` (one interest only — do not stack) |
| Placements | Auto |
| Expected CPL | $30–45 CAD |
| Creative load | 2 ads (Angle 2 — lifestyle/downsizer hooks only) |

**Purpose:** Test whether a downsizer-creative set outperforms broad on the same audience. Kill if CPL runs 25%+ higher than Ad Set A after 2 weeks + $100 spend.

**COMPLIANCE NOTE (updated 2026-05-11):** Housing Special Ad Category (which applies to residential construction/tiny homes) prohibits age, gender, and postal code targeting. The original age 50-70 targeting is not permitted. Ad Set B must rely on creative differentiation only (Angle 2 lifestyle/downsizer hook) to self-select the downsizer audience — Meta's algorithm will find them via creative signal. This is actually consistent with the Andromeda broad-targeting strategy. Remove the age range at setup.

---

## Lead Form Design

**Principle: Short, mobile-first, every extra field costs leads.**

**Form name:** "Talk to Joey — Titan Tiny Homes"
**Form type:** Higher intent (adds a review step — reduces spam leads)

**Fields:**
1. First name *(pre-filled by Meta)*
2. Email *(pre-filled)*
3. Phone *(optional — labelled clearly as "Optional")*
4. Qualifying question: *"Do you already have land, or are you still exploring your options?"*
   - Options: "I have land" / "I'm exploring" / "I have land but it's zoned residential"

**Intro screen headline:** "Custom tiny homes built in Ontario. Let's talk."
**Intro screen body:** "Joey and Kathryn build every home themselves. Tell us what you're looking for and we'll be in touch within 1 business day."
**Privacy policy:** titantinyhomes.ca/privacy (dev to confirm this URL exists)
**Thank-you headline:** "Thanks — we'll be in touch."
**Thank-you body:** "Joey reads every inquiry personally. Expect to hear from him within 1 business day."

---

## Warm vs. Cold Audience Strategy

**Phase 1 (now — pre-pixel):** Cold audiences only. All targeting is interest-based or broad. No retargeting.

**Phase 2 (post-pixel install):** Add retargeting ad sets:
- Website visitors (last 30 days) — highest intent
- Video viewers (50%+ of any video ad) — warm signal
- Lookalike: 1% Ontario lookalike of lead form completers (build after 100+ leads collected)

Phase 2 can increase total lead volume 30–50% without increasing budget. Joey should expedite pixel install.

---

## Creative Angles (5 to Test in Stage 3)

Full creative bundle in: `orgs/glv/clients/titan/deliverables/campaigns/2026-04-titan-creative-bundle/`

| Angle | Hook | Format | Ad Set | Priority |
|-------|------|--------|--------|----------|
| 1 — Affordability | "Own a home under $150K while your neighbors pay $350K+" | Carousel | A (Broad) | 🔴 First |
| 2 — Lifestyle/Downsizer | "The kids are grown. The house is too big. There's another way." | Video (30–60s) | A + B | 🔴 First |
| 3 — Land Owner | "Got land in Ontario? We've got your home." | Static image | A (Broad) | 🟡 Second |
| 4 — Build Process | "Watch a Titan tiny home get built — start to finish" | Reel (60–90s) | A (Broad) | 🟡 Second |
| 5 — Local Market | "Why more Ontario families are choosing tiny homes in 2026" | Carousel | A (Broad) | 🟢 Third |

**Launch order:** Start with Angles 1 and 2 only (less creative = faster learning phase exit). Add 3 and 4 after first optimization review at day 14.

---

## KPI Targets

### Month 1 (Learning Phase — Do Not Optimize Aggressively)

| Metric | Conservative | Target | Strong |
|--------|-------------|--------|--------|
| Leads | 10 | 17 | 22 |
| CPL | $70 | $50 | $40 |
| CTR | 0.6% | 1.0% | 1.8% |
| Lead form CVR | 5% | 8% | 12% |
| Impressions | 15,000 | 28,000 | 45,000 |
| Frequency | < 2.5 | < 2.0 | < 1.5 |

*Month 1 is data collection, not scale. CPL will be higher weeks 1–2 as algorithm learns. Do not kill campaigns in the first 7 days based on CPL alone.*

*CTR targets revised May 2026: Meta attribution change (Q1 2026) now counts only real link clicks, not reactions/comments/shares — reduces reported CTR ~15-30% vs historical baselines. CPL targets revised upward based on SuperAds.ai Canada-specific data (Dec 2025 endpoint ~$87 CAD real estate). See experiments/ontario-tier2-meta-benchmarks-2025-2026.md.*

### Month 2+ (Post-Learning)

| Metric | Target |
|--------|--------|
| CPL | $40–70 CAD |
| Leads/month | 10–20 |
| Quote requests (20% of leads) | 2–4/month |
| Cost per qualified opportunity | $175–250 CAD |

---

## Decision Rules (Kill / Hold / Scale)

### Kill a specific ad:
- After $40 spend AND 0 leads, OR
- After 7 days with CTR consistently below 0.6% *(revised from 0.8% — Meta Q1 2026 attribution change counts real link clicks only)*

### Kill Ad Set B (Downsizer):
- After $100 spend AND CPL is 25%+ higher than Ad Set A

### Hold — do NOT change:
- Anything in the first 14 days (resets learning phase)
- Budget (even modest increases reset learning)
- Audience settings

### Scale a budget:
- After 3 consecutive days with CPL below $45 CAD: increase daily budget by 20% *(revised from $28 — Canada-specific benchmark update)*
- After 30 days with CPL below $50 AND leads > 10/month: increase to $700/mo *(revised from $30/15)*

### Graduate to Ontario-wide + retargeting (Phase 2):
- After 100 cumulative lead form completions (sufficient for lookalike seed)
- After pixel confirmed firing on titantinyhomes.ca

---

## Implementation Sequence (Stage 4 — Gated on Meta BM + Pixel)

When Meta BM and pixel are confirmed:

1. Create Pixel in Meta Events Manager → install on titantinyhomes.ca (1 line in `<head>`)
2. Verify pixel is firing via Meta Pixel Helper Chrome extension
3. Create Lead Gen campaign (CBO, $16.67/day)
   - **File campaign under "Housing" Special Ad Category** — required for residential construction; failure to do so causes ad rejection
4. Create Ad Set A (Broad Ontario — no age/gender targeting per Housing SAC)
5. Create Ad Set B (Downsizer — Minimalism interest only; no age targeting per Housing SAC)
6. Build lead form "Talk to Joey"
7. Load Angle 1 + Angle 2 ads into each ad set
   - **Audit Advantage+ Creative enhancements before launch** — all are ON by default since Feb 2026. Disable: background generation, music overlays. Evaluate: text variations, contrast. Keep: aspect ratio adjustments.
   - **Check creative assets for AI-generated/AI-modified content** — disclosure label required by Meta since March 2026 if any AI-assisted visuals are used
8. Launch — note launch date and time
9. Do not touch for 14 days
10. Day 14 review: kill underperformers, add Angles 3 + 4

---

## Reporting Cadence

| Frequency | What |
|-----------|------|
| Weekly | Pull CPL, CTR, lead count, frequency — flag anything outside targets |
| Monthly | Full performance report → route to Aiden for review |
| After 100 leads | Lookalike audience build + Phase 2 retargeting layer |

---

## Competitive Moat (What Makes This Defensible)

1. **No competitors geo-targeting Ontario** with founder-UGC + local craftsmanship story
2. **Joey + Kathryn on camera** = Andromeda advantage; algorithm amplifies authentic content over polished production
3. **Land qualifier question** pre-screens leads; Joey prioritizes "I have land" responders — higher close rate
4. **Ontario Building Code compliance** in every ad — legitimacy signal competitors underuse
5. **Realtor partnership (Trisha)** creates warm referral channel that supplements cold Meta leads

---

*DRAFT — GLV Marketing internal. Pending Aiden approval before any spend or campaign build.*
*Stage 3 creative bundle: 2026-04-titan-creative-bundle/ (filed concurrently)*
