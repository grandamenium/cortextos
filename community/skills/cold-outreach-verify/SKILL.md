---
name: cold-outreach-verify
description: "Pre-send verification stack for cold outreach drafts. Seven-category Phi Accrual multi-source bidirectional verify, with per-category ≥2 independent sources, ≥90% per-prospect clean-claim threshold, and tier-mismatch screening before any comparative claim. Single source of truth for the cold-outreach send gate."
triggers: ["verify cold outreach", "cold-outreach verify", "pre-send verify", "phi accrual verify", "verify draft before send", "source fact ledger"]
external_calls: ["curl", "getent (DNS)", "SEMrush", "GMB / Google Maps", "BBB", "Yellow Pages", "LinkedIn", "Birdeye / Trustpilot"]
---

# Cold-Outreach Verify

> Seven-category Phi Accrual multi-source bidirectional verification gate.
> Mandatory between research and draft creation. No exceptions.
> Replaces the old "WebFetch + ledger lookup" stack that ships 5/5 with at least one false claim.

---

## Why This Exists

A factual error in a cold email is not a typo. The prospect knows their own business better than any research tool. One wrong stat, one wrong name, one wrong "site is down" — and the entire email reads as if we never actually looked at them. Worse: it reads as if AI wrote it without checking.

This gate is the floor, not the ceiling. Drafts may also be killed for tone, hook strength, or strategic fit — but they cannot be sent unless every factual claim survives this gate.

**Worked example (GLV prospector, 2026-05-11):** Five batch-1 drafts hit Aiden's Gmail. All five had at least one wrong claim under the old (WebFetch + 3–5wk ledger) stack. Aiden caught the first one (site claimed down, actually loads), flagged the rest, and pulled the batch. Trust was preserved only because the human caught what the gate did not. The 7-category stack below is what replaced that gate.

---

## CRITICAL RULES — READ FIRST

1. **No claim ships without ≥2 independent sources.** Independent = different operators (not the same data syndicated through different surfaces). Birdeye republishing a Google review count is not a second source for Google review count.
2. **Comparative claims must verify both sides.** "Their reviews vs Competitor X" requires verifying Competitor X with the same rigor — same date, same sources.
3. **Tier-mismatch is its own failure class.** If you are comparing a small residential operator to a regional industrial giant, the comparison is structurally insulting regardless of which side has more reviews. Verify peer-tier (service scale, customer segment, geo) before publishing any comparative.
4. **Send-day freshness is mandatory.** A claim verified yesterday is not verified today. If >6h has passed between verify and send, re-verify. Review counts, site state, and people-claims change inside 24h.
5. **≥90% per-prospect clean-claim rate is the floor.** If a draft contains 10 verifiable claims and 1 cannot be confirmed, that is a FLAG, not a soft pass. Either fix or kill the claim — never ship a "close enough" claim.
6. **Methodology delta must be logged on every gate run.** If this gate caught something the old stack would have missed, record it. That's the evidence trail for ongoing methodology improvement.

---

## The Seven Categories

Every factual claim in a cold-outreach draft must map to one of these categories and clear its verification bar.

### Category 1 — Site state

**What it covers:** "Their site is down" / "redirects to nothing" / "parked for sale" / "only loads on HTTP" / "404s on every page" / "has only N pages".

**Verification:**
- Use the `site-availability-verify` skill (4-step DNS + curl HEAD + curl GET + redirect-target check) — this is the floor.
- For *content* claims (page count, missing service pages, broken contact form), follow with a real browser load (Playwright equivalent). WebFetch can miss JS-rendered DOM and is not authoritative on rendered content.

**Sources required (≥2 independent):**
- Site itself (browser-rendered, not just curl body)
- One of: archive.org snapshot from this week, a third-party uptime monitor, BBB-listed website status, a search-result preview that exposes the live title/meta

**Banned shortcut:** Inferring site state from a WebFetch error alone.

---

### Category 2 — Review counts and ratings

**What it covers:** "You have N Google reviews", "your rating is X.X", "you have more / fewer reviews than Competitor Y".

**Verification:**
- Live Google Business Profile pull (current day's count, not a ledger entry from last week).
- Cross-check on a second independent surface: Birdeye, Trustpilot, Yelp, HomeStars, BBB. NOTE: many of these republish Google's count — only count it as independent if it has its own reviewer pool.
- Comparative claims: pull the competitor on the same day with the same sources.

**Sources required (≥2 independent):**
- GBP live
- One independent-pool surface (different reviewers, not a republisher)

**Banned shortcuts:**
- Citing review counts from a research dossier older than the current calendar day.
- Inferring rating from an aggregator badge.

---

### Category 3 — Traffic and keyword claims

**What it covers:** "Competitor X is pulling N/month for HVAC searches", "you rank #N for keyword Y", "the gap is closeable".

**Verification:**
- Live SEMrush pull (current month index).
- Cross-check on Ahrefs where available, or on Google itself via a careful site-restricted SERP check.
- For comparative ("X leads, you trail"): pull BOTH sides on the same day with the same tool.

**Sources required (≥2 independent):**
- One paid tool (SEMrush or Ahrefs) current-month index
- One direct SERP observation matching the claim

**Banned shortcuts:**
- Inferring traffic from a ranking screenshot.
- Quoting "leading" / "biggest" / "only" without a city-wide sweep that supports those words. "Leads" requires showing the ranking; "only" requires showing the rest of the field is below.

---

### Category 4 — Brand still operating

**What it covers:** "You are a 60-year-old company", "you've been in business since YYYY", any claim that requires the business to still be running under the same identity.

**Verification:**
- BBB current status check (active, suspended, no record).
- Yellow Pages active listing.
- Domain registrant / ISP lookup (whois) — domain currency proves nothing alone, but a domain that lapsed last quarter is a red flag.
- For tenure: prefer the company's own About page, then BBB founding year, then Yellow Pages "in business since".

**Sources required (≥2 independent):**
- BBB or equivalent regulator/registry
- The company's own current website OR a recent (≤90 day) third-party news / social mention

**Banned shortcuts:**
- Quoting tenure without a current-day operating signal.
- Trusting a "we've been here since YYYY" line from a research dossier when other surfaces show conflicting tenure.

---

### Category 5 — People claims

**What it covers:** Addressing a draft by name ("Hi Norm" / "Hi Ben"), references to a specific owner, manager, or staff member.

**Verification:**
- LinkedIn current employer field (must show the prospect company as current).
- GMB "About" / "From the owner" section.
- A recent review (≤180 days) that mentions the person by name OR a recent local-news / chamber-of-commerce mention.

**Sources required (≥2 independent):**
- LinkedIn current employer
- One of: GMB About, recent review by name, recent news/social

**Banned shortcuts:**
- Carrying a name from a research dossier without re-verifying current employer.
- Inferring the owner from the email username (e.g., `norm@...` does not prove Norm is still there).

---

### Category 6 — Competitor positioning

**What it covers:** Any comparative ("Competitor X is doing better at Y"), any claim that names a specific competitor as a reference point.

**Verification:**
- Full SEMrush sweep of the city+vertical (not just the one named competitor) — this prevents cherry-picking.
- Verify the competitor with EVERY claim that touches them (reviews, tenure, scale, geo, customer segment).
- **Tier-mismatch screen:** before publishing the comparative, answer all four:
  1. Same service scale? (small residential vs regional industrial = MISMATCH)
  2. Same customer segment? (B2C plumbing vs B2B mechanical contracting = MISMATCH)
  3. Same geo? (Sault Ste. Marie shop vs Sudbury+North Bay regional = MISMATCH)
  4. Same business model? (owner-operator vs franchise / corporate = MISMATCH)
  - Any single MISMATCH → comparative is structurally insulting → either kill or pick a peer-tier competitor.

**Sources required (≥2 independent):**
- One paid SEO tool (SEMrush / Ahrefs)
- One direct surface check (their site, GBP, BBB) confirming tier match

**Banned shortcuts:**
- Naming the biggest local competitor "because they're easy to find" without checking tier.
- Quoting "they are the leader" without a city-wide sweep.

---

### Category 7 — Hook freshness

**What it covers:** The single most load-bearing claim — the one the cold email opens on. The hook is the reason for the email; if it has shifted state since research, the email's premise is gone.

**Verification:**
- Live re-verify on send-day, immediately before draft enters the send queue. Not at draft-creation time — at send time.
- If the gap between research and send is >6h, the hook re-verify is mandatory regardless.
- Any state-shift (site went up, site went down, owner changed, reviews jumped, parked-for-sale flipped to operating) → **KILL** and re-research with the full 9-step. Do not patch.

**Sources required:** Whatever Category 1-6 the hook lives in, run that category's verify ON THE DAY OF SEND.

**Banned shortcuts:**
- "Verified yesterday is good enough." It is not.
- "The research dossier said X, the WebFetch agreed, ship it." Tool agreement on stale state is not freshness.

---

## The Source-Fact Ledger

Every cold-outreach draft must carry a ledger in this format. The ledger is part of the deliverable.

```
## Source-Fact Ledger — [Business Name]

Draft ID: [Gmail draft ID once created]
Verified at: [ISO timestamp]
Verified by: [agent name]

| # | Claim in email | Verified value | Category | Source 1 | Source 2 | Checked |
|---|---|---|---|---|---|---|
| 1 | "[exact quote]" | [actual value] | [1-7] | [URL/tool] | [URL/tool] | [date] |
| 2 | "[exact quote]" | [actual value] | [1-7] | [URL/tool] | [URL/tool] | [date] |

Tier-mismatch screen (if any comparative): PASS / FAIL — [4-question result]
Clean-claim rate: [N/M] = [%]
Methodology delta vs old stack: [what this run caught that WebFetch+ledger would have missed]

VERDICT: PASS | FLAG | KILL
```

- **PASS** requires ≥90% clean-claim rate AND no FLAG-grade items AND tier-mismatch PASS where applicable.
- **FLAG** routes to a human (or to boss for triage) before any send action.
- **KILL** means the hook is dead; do not draft a substitute claim in the same surface — re-research and rebuild.

---

## How to Run the Gate

For each cold-outreach draft:

1. **Enumerate every factual claim** in the draft body, subject, and PS. Number them.
2. **Map each claim to a category (1–7).** If a claim spans two categories, run both verifications.
3. **For each claim, gather ≥2 independent sources.** Cite URL or tool + date.
4. **Run the tier-mismatch screen on every comparative.**
5. **Re-run Category 7 (hook freshness) on the send day, immediately before queueing.** If >6h has passed since the rest of the gate, re-run all categories the hook touches.
6. **Compute clean-claim rate.** Verified / total. Must be ≥90%.
7. **Record methodology delta.** What did this run catch that the old (WebFetch + ledger) stack would have missed? If "nothing", that's a valid entry — it builds the trail that the new stack is converging.
8. **Stamp VERDICT.** PASS → create the Gmail draft. FLAG → route to a human. KILL → kill the hook.

---

## Banned Sources / Banned Shortcuts (consolidated)

- Research dossiers older than the current calendar day for any time-sensitive claim (reviews, traffic, site state, people).
- WebFetch as sole verification for site state.
- Aggregator republished review counts as a "second source" for the original platform's count.
- "I believe" / "probably" / "should be" anywhere in the ledger.
- The biggest visible competitor as the comparator without a tier-mismatch screen.
- Owner names carried from a dossier without LinkedIn re-verify.
- Tool agreement on stale state ("WebFetch and the dossier both say X, ship it").

---

## Integration With Outreach Pipeline

```
9-step research → COLD-OUTREACH-VERIFY GATE → draft body → re-run Cat 7 at send-time → Gmail draft → send
                                              ↓ FLAG     → boss inbox for triage
                                              ↓ KILL     → re-research, new hook
```

The ledger is stored alongside the draft record (e.g., `deliverables/<batch>/<prospect>-ledger.md`) and surfaced with the draft when it goes to a human for review.

---

## Tool Acquisition Flags

This gate is load-bearing on tools the agent may not have today. If any are missing, the gate runs in degraded mode and the missing-tool caveat MUST appear in the ledger's methodology delta field.

| Tool | Used for | Status |
|---|---|---|
| Playwright (or Chromium-bundled equivalent) | Category 1 content claims, Category 2 widget verification | Acquire — WebFetch is insufficient |
| Live SEMrush API | Category 3 traffic + keyword, Category 6 competitor sweep | Acquire — manual dashboard pulls don't scale |
| Live GMB direct read | Category 2 review counts, Category 5 GMB About | Acquire — search snippets are stale |
| Birdeye / Trustpilot direct | Category 2 independent-pool verification | Nice-to-have |
| LinkedIn structured access | Category 5 current employer | Acquire — manual scrapes hit 999s |

Each missing tool is a cost-justification entry for the analyst / cycle owner to escalate.

---

## Worked Example — Batch 1 Rebuild (GLV Prospector, 2026-05-11)

| Prospect | Old-stack verdict | NEW-stack verdict | Methodology delta |
|---|---|---|---|
| Beebe Mechanical | SHIP ("site down") | KILL — site loads cleanly; comparator (Clow Darling) is tier-mismatch | WebFetch socket-closed ≠ real visitor; tier-mismatch sub-rule activated |
| Ben's Plumbing & Heating | SHIP ("no phone, no site linked") | REBUILD — domain offline holds, but phone IS listed on 5 directories | Category 4 brand-operating cross-check caught the phone error |
| Robert's Plumbing | SHIP ("redirect, no content") | KILL — site is parked-for-sale (categorical fact-pattern shift), owner is Robert Squitti not Norm | Category 1 GET-body inspection caught GoDaddy parking; Category 5 LinkedIn caught wrong-name |
| Adept Plumbing | SHIP ("one Google review and a homepage") | REBUILD — "no service pages" substance holds; "one homepage" mischaracterizes; review count unverifiable | Category 1 page count verified; Category 2 review count flagged |
| Priest Plumbing | SHIP (review count gap 52 vs 84) | REBUILD WITH SWAP — wrong numbers (53/71 actual); swap to on-page empty-testimonials hook | Category 2 review counts re-verified; competitor-data-dependency eliminated |

**Result:** 0 of 5 would have shipped clean under the old stack. 5 of 5 were either rebuilt or killed under the new stack before any send. Aiden's trust slot preserved.

---

## Cycle-18 Sub-Rules (banked as enforcement gates)

1. **Sweep-target ≡ shipped-copy-hook.** When re-verifying a draft, retrieve the hook from the deliverable's ledger field, NOT from historical chat / Slack posts.
2. **Direct-visual-evidence redrafts** (boss-redraft path with screenshot) acceptable if ≥80% body coverage; unverified residuals → post-send claims-verify pass.
3. **Network-layer state-shift = KILL + re-research.** A site that flipped state since the last verify cannot have its hook patched — rebuild.
4. **WebFetch + ledger-lookup is insufficient.** Phi Accrual 7-category multi-source bidirectional is the new minimum.
5. **Tier-mismatch is a failure class.** Comparative claims require peer-tier verification (service scale, customer segment, geo, business model) before publish.

---

## What This Skill Does NOT Cover

- Copy quality, tone, hook strength, CTA fit. Those are the copy-iteration gate's job.
- CASL / legal compliance. Those are the sender's responsibility — see `feedback_outreach_claim_freshness` and CASL one-touch policy.
- Deliverability / SPF / DKIM / DMARC. Those are infrastructure-side gates run by the pentester / dev.
- Send pacing and warm-up cadence. That is the outreach-orchestration job.

This skill verifies that the facts in the draft are true on send-day. That is its entire scope.

---

## Manual Trigger

```
"Run cold-outreach verify on [draft]" → read .claude/skills/cold-outreach-verify/SKILL.md and execute the gate.
```

---

*This is the single source of truth for the cold-outreach pre-send factual-verification gate.*
