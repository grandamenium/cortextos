---
name: quick-vet
description: "Instant breakdown of a single business shared via any channel — computes the multiple, names the central question, tiers it (Pursue/Watch/Pass), and flags the top 3 risks, in one tight reply. NO research agents, NO deliverables. Escalates to the full `deal-workup` skill only on a Pursue + user go-ahead. Owner: pm methodology."
triggers: ["quick vet", "quick-vet this", "should I look at this", "thoughts on this business", "is this a deal", "vet this listing", "what do you think of this one"]
---

# quick-vet Skill

The lightweight front-end to `deal-workup`. Every business shared gets this instant read; only the ones that clear it get the full 6-deliverable workup. Trigger: a single business shared via Telegram / email / notes / a listing link or pasted summary.

**This skill does NOT dispatch research agents or produce files.** It is a fast, in-line judgment call. If the business merits the full treatment, it hands off to `deal-workup`.

---

## HOUSE RULES

1. **Never fabricate URLs** — no listing URL, no preview URL. If the listing is gated, ask for the link or use pasted text.
2. **Label figures illustrative** — all financials are seller-reported unless stated otherwise.
3. **Single-quote bash** — for any Telegram message containing dollar amounts.
4. **No research agents** — this skill is inline only. Agent dispatch is `deal-workup`'s job.
5. **Escalation gate** — only hand off to `deal-workup` on an explicit PURSUE + user go-ahead.

---

## INPUT FORMAT

**Required:** One business — any of the following:
- Listing URL (attempt fetch; if gated/blocked, ask user to paste the text and provide the broker link separately)
- Pasted seller summary / teaser text
- Forwarded Telegram message with deal details

**Optional:**
- Buyer profile or investment thesis
- Any specific concern the user wants flagged

---

## STEPS

### 1. Parse

Extract from the input:
- Business name / category
- Annual revenue (TTM)
- SDE or EBITDA (note which basis)
- Asking price
- Location, headcount, years operating
- Any obvious flags (declining revenue, key-person cliff, platform concentration, etc.)

### 2. Compute

```
SDE_MULTIPLE  = Asking Price ÷ SDE   (state if using EBITDA instead)
REV_MULTIPLE  = Asking Price ÷ Annual Revenue
MARGIN        = SDE ÷ Annual Revenue × 100
```

### 3. Headline

Rate vs. asset-class norms:
- **Service businesses:** ~2.5–4× SDE is fair
- **E-commerce:** ~2.5–4× SDE is fair
- **SaaS:** ~3–5× ARR is fair
- **Content / media:** typically lower, context-dependent
- **Main-street / brick-and-mortar:** ~2.5–4× EBITDA is fair

Label: **CHEAP** (meaningfully below median), **FAIR** (within ±0.5× of median), or **RICH** (above median — note what the premium is pricing in).

### 4. Central Question

Name the ONE thing the deal turns on. Examples:
- Owner-dependence (can it run without the seller?)
- Platform concentration (>50% revenue from one channel/partner?)
- Payer mix (who actually pays, and is that stable?)
- Margin fixability (is low margin structural or fixable?)
- Mechanism legitimacy (is the revenue source durable?)
- Customer concentration (top customer = >20–30% of revenue?)

### 5. Score (deterministic rubric — same inputs MUST produce the same score)

Score each deal 0–100 using fixed point values. Unknowns take the fixed **conservative default** shown (deliberately set low-to-mid, NOT a true midpoint — an unknown should never help a deal's score) — never guess a value to move the score.

| Component | Max | Points |
|---|---|---|
| **Multiple vs asset-class norm** | 30 | CHEAP = 30 · FAIR = 20 · RICH = 8 · no ask/SDE stated (uncomputable) = 10 |
| **Revenue trend** | 20 | growing = 20 · flat = 12 · declining = 3 (sustained down-trend SHORT of collapse — see structural-killer below) · unstated = 8 |
| **Industry risk** | 15 | low = 15 · medium = 9 · high (secular decline, platform-dependent category, regulatory cliff) = 3 · unknown = 8. Use `industry-profile` output (`risk_factors`, `life_cycle_stage`) when available; else judge from category. |
| **Owner dependency** | 15 | absentee/manager-run = 15 · owner active but team in place = 9 · key-person cliff (owner IS the business) = 3 · unstated = 7 |
| **Deal type** | 10 | asset sale = 10 · stock sale = 6 · unstated = 5 |
| **Ask price stated** | 10 | stated = 10 · request-conversation model (Rejigg-style, by design) = 5 · simply absent = 3 |

> **Missing-ask double-count is BY DESIGN, not a bug — do not "dedupe" it.** A deal with no ask is reflected in TWO components (Multiple uncomputable = 10 AND Ask price absent = 3) because a missing price both blocks valuation and lowers deal quality. For request-conversation models (Rejigg / Accredited "by design" no-ask), the Ask component uses its = 5 value, which deliberately softens the effect. Leave both in.

**Rating bands** (with tier mapping — the deals board `tier` field keeps the pursue/watch/pass vocabulary):

| Score | Rating | Board tier |
|---|---|---|
| ≥ 70 | **STRONG** | `pursue` |
| 45–69 | **WATCHLIST** | `watch` |
| < 45 | **PASS** | `pass` |

Every rating gets a **1-sentence rationale** naming the dominant factor (e.g. "STRONG — 2.4x on growing revenue with a GM already running ops.").

**Structural-killer override (the ONLY thing that overrides the numeric band):** a genuine structural killer forces PASS regardless of score — say so explicitly. Killers are: **fraud smell**, **revenue collapse** (>~30% YoY decline, or going-concern doubt — distinct from ordinary "declining", which is scored at 3, not an override), **unfixable concentration >70%** (one channel/customer/platform). Ordinary weaknesses (key-person dependence, a rich ask, a merely-declining trend) are ALREADY captured in the numeric score and are NOT overrides — do not double-apply them.

### 5b. Tier (derived from §5 — do NOT re-judge)

Tier is a **direct mapping** from the §5 rating band. The numeric band (§5) is authoritative; there is no separate prose tier test here (a second path would re-introduce non-determinism):

- **STRONG (≥ 70) → PURSUE** — merits the full workup
- **WATCHLIST (45–69) → WATCH** — name the single concern that blocks an immediate move
- **PASS (< 45) → PASS**

The only override is the §5 structural-killer rule above, which forces PASS.

### 6. Top 3 Risks

One line each. If relevant to the user's known buyer profile, add a buyer-fit angle.

---

## OUTPUT FORMAT

Telegram-ready, no file, no attachment. Deliver inline:

```
[Name] — [category] · $[ask] / $[SDE] SDE / [mult]× · [CHEAP/FAIR/RICH]
Central question: [the one thing it turns on]
Score: [NN]/100 — RATING: STRONG / WATCHLIST / PASS — [1-sentence rationale]
Tier: PURSUE / WATCH / PASS
Risks: 1) … 2) … 3) …
[one-line buyer-fit note, if relevant]
```

Send via: `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID '<message>'` (single quotes for $ amounts).

---

## ESCALATION

**If PURSUE:** ask the user whether to proceed with the full workup.

If they say go → invoke the `deal-workup` skill with the same input. quick-vet is the screen; deal-workup is the build.

If they say not yet / pass → log the tier and move on. No task created unless user requests.

**If WATCH or PASS:** deliver the output. No escalation unless the user asks to dig deeper.

---

## WHAT YOU HANDLE VS. WHAT GOES TO PM

**Handle autonomously:**
- All computation and categorization
- Choosing which 3 risks to surface (use judgment)
- Formatting and Telegram delivery
- Asking for gated listing text if URL is blocked

**Route to pm (do not decide yourself):**
- Whether to submit an LOI after a PURSUE verdict
- Analytical template changes (new output sections, different multiple benchmarks)
- Tier override if user context contradicts your read
- Any finding so unusual it warrants a methodology question

---

_Skill owner: pm (analytical content) / devops (registration + mechanics). Pairs with `deal-workup` (full pipeline) and `deal-flow-scan` (batch/inbox version). Last updated: 2026-07-02 (deterministic 0–100 scoring rubric + STRONG/WATCHLIST/PASS rating; rubric-consistency fixes — conservative-default wording, §5 band made authoritative over §5b, declining-vs-collapse threshold, missing-ask double-count documented)._
