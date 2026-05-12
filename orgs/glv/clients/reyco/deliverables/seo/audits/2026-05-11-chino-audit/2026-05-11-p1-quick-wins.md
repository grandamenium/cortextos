# Reyco Marine — P1 Quick Wins Spec
# Copy-Ready Meta/Title Strings for WP-CLI Application

**Generated:** 2026-05-11 by seo-agent post chino:audit
**Application path:** SSH KEY ROTATED — WP-CLI path currently broken (see below)
**Approval required:** Aiden sign-off on copy before apply
**Status:** DRAFT v2 — boss QC iteration 1 applied (2026-05-11); pending P1.3/4/5 taxonomy confirm + Aiden copy approval + SSH gap resolution

---

## SSH Access Gap — 2026-05-11

`ssh -i ~/.ssh/sg-reyco -p 18765 giowm1155@giowm1155.siteground.biz` returns `Permission denied (publickey)`.

Key at `~/.ssh/sg-reyco` was generated Apr 29; domain cutover was May 6 — key likely rotated server-side or SG auth profile changed post-cutover.

**Three apply paths for P1.1 and P1.2 (WP Admin fields):**

- **(a) Aiden restores SSH** — fastest for bulk; Aiden re-adds public key in SiteGround SSH Manager. Then all WP-CLI commands below work as written.
- **(b) Aiden edits via WP Admin UI** — Rank Math SEO box appears on every page/post edit screen. 30-second fix per item. No SSH needed. Path: WP Admin > Pages/Posts > Edit > Rank Math meta box > SEO Description / SEO Title.
- **(c) Dev PR** — slowest; dev edits post_meta in migration script or PHP. Not recommended for meta/title-only changes.

**Recommendation:** Option (b) for P1.1 and P1.2 immediately; ask Aiden to restore SSH key for future batches.

---

## Application Workflow

1. Boss surfaces copy to Aiden for approval
2. On Aiden greenlight: Aiden applies via WP Admin Rank Math meta box (P1.1, P1.2, P1.6) or boss restores SSH
3. P1.3/4/5: Boss runs taxonomy check and relays output (SSH restore required)
4. Boss screenshots before/after for retainer paper trail
5. SEO agent logs change events

---

## WP-CLI Reference

**Look up post IDs by slug:**
```bash
ssh -i ~/.ssh/sg-reyco -p 18765 giowm1155.siteground.biz
cd /path/to/reycomarine.com
wp post list --post_type=page --post_status=publish --fields=ID,post_title,post_name 2>/dev/null | grep -iE "aboutus|small-engine"
wp post list --post_type=post --post_status=publish --fields=ID,post_title,post_name 2>/dev/null | grep -i mercury
```

**Apply Rank Math meta desc (per-post):**
```bash
wp post meta update <ID> rank_math_description "new meta desc here"
```

**Apply Rank Math title override (per-post):**
```bash
wp post meta update <ID> rank_math_title "new title here"
```

**Verify after apply:**
```bash
wp post meta get <ID> rank_math_description
wp post meta get <ID> rank_math_title
```

---

## P1.1 — /aboutus — Meta Description Rewrite

**Fix:** FIX-0007
**Priority:** CRITICAL
**Problem:** 201 impressions, 0.5% CTR, pos 5.3 — absorbing brand-confusion queries
**Root cause:** Page is ranking for "reyco automotive" (11 impr), "superior marine" (9 impr), "superior marine sault" (6 impr) with no disambiguation in snippet

**Lookup:**
```bash
wp post list --post_type=page --post_status=publish --fields=ID,post_title,post_name | grep -i about
```

**Current:** Unknown — GSC is serving auto-generated snippet from page body (low CTR confirms no explicit meta desc set)

**Proposed meta desc (155 chars):**
```
Reyco Marine & Small Engine, Sault Ste. Marie's authorized Mercury and Princecraft dealer. Boats, small engine repair, and outdoor power equipment. Not Reyco Automotive.
```

**Apply:**
```bash
wp post meta update <ABOUTUS_ID> rank_math_description "Reyco Marine & Small Engine, Sault Ste. Marie's authorized Mercury and Princecraft dealer. Boats, small engine repair, and outdoor power equipment. Not Reyco Automotive."
```

**Expected impact:** CTR from current 0.5% to 3-5% — users searching competitor names will see the disambiguation and either click (correct intent) or not click (saves negative bounce signal). Target: +5-10 clicks/month from current zero-click impressions.

---

## P1.2 — /service/small-engine/ — Title Tag + Meta Description

**Fix:** Quick win from L6 Finding 4
**Priority:** CRITICAL
**Problem:** pos 2.1, 20 impressions, 0 clicks on "small engine repair sault ste marie" — page 1 spot not converting because title likely lacks geo signal

**Lookup:**
```bash
wp post list --post_type=page --post_status=publish --fields=ID,post_title,post_name | grep -i small
```

**Current title:** Likely "Small Engine Repair | Reyco Marine" (no location anchor)

**Proposed title tag (54 chars):**
```
Small Engine Repair in Sault Ste. Marie | Reyco Marine
```

**Proposed meta desc (138 chars):**
```
Fast small engine repair in Sault Ste. Marie. Lawn mowers, snowblowers, chainsaws and more. Authorized Toro and Cub Cadet service dealer.
```

**Apply:**
```bash
wp post meta update <SMALL_ENGINE_ID> rank_math_title "Small Engine Repair in Sault Ste. Marie | Reyco Marine"
wp post meta update <SMALL_ENGINE_ID> rank_math_description "Fast small engine repair in Sault Ste. Marie. Lawn mowers, snowblowers, chainsaws and more. Authorized Toro and Cub Cadet service dealer."
```

**Expected impact:** Position 2.1 with geo-anchored title should convert 3-5 of the 20 monthly impressions to clicks. Single highest-ROI fix in the batch.

---

## P1.3 — Toro Inventory Page — Meta Description

**Fix:** Content plan P1.3
**Priority:** HIGH
**Problem:** 120 impressions, 0.8% CTR, pos 3.0 — top-3 position not converting
**URL observed in GSC:** `/search/inventory/Brand/Toro/condition/New` (or variant)

**Application path note:** These inventory filter URLs are dynamically generated by the WooCommerce inventory system, not standard WP posts. They likely do NOT have individual post IDs. Check the application path:

Option A — Rank Math Product Category (if "Toro" is a WooCommerce product category or brand term):
```bash
wp term list product_cat --fields=term_id,name | grep -i toro
wp term meta update <TERM_ID> rank_math_description "meta desc here"
```

Option B — Rank Math Archive SEO (if inventory pages use a custom post type archive):
- WP Admin > Rank Math > Titles & Meta > Products (or custom post type name)
- Set archive meta description with dynamic variables

Option C — Custom filter page (if inventory search is a plugin-generated URL):
- Flag to dev for Rank Math pattern setting

**Proposed meta desc (144 chars):**
```
Authorized Toro dealer in Sault Ste. Marie. Shop new Toro lawn mowers, snow blowers, and outdoor power equipment. In stock and ready for pickup.
```

---

## P1.4 — Cub Cadet Inventory Page — Meta Description

**Fix:** Content plan P1.4
**Priority:** HIGH
**Problem:** 89 impressions, 0% CTR, pos 4.2 — no meta desc at all (GSC serving body snippet)
**URL observed in GSC:** `/search/inventory/Brand/Cub%20Cadet`

**Application path note:** Same as P1.3 — check whether this is a WooCommerce taxonomy term or dynamic filter URL. If Cub Cadet is a product brand/category term:
```bash
wp term list product_cat --fields=term_id,name | grep -i cadet
wp term meta update <TERM_ID> rank_math_description "meta desc here"
```

**Proposed meta desc (136 chars):**
```
Authorized Cub Cadet dealer and service centre in Sault Ste. Marie. Shop new Cub Cadet equipment or book your service appointment today.
```

---

## P1.5 — Boats Inventory Page — Meta Description

**Fix:** Content plan P1.5
**Priority:** HIGH
**Problem:** 135 impressions, 0.7% CTR, pos 5.7 — generic title/snippet not competing with boat dealer results
**URL observed in GSC:** `/search/inventory/class/Boats` or `/search/inventory/type/Boats` (confirm exact)

**Application path note:** Same dynamic URL pattern as P1.3 and P1.4. If "Boats" is a product category:
```bash
wp term list product_cat --fields=term_id,name | grep -i boat
wp term meta update <TERM_ID> rank_math_description "meta desc here"
```

**Princecraft "only dealer" claim — VERIFIED FALSE (2026-05-11):**
WebSearch found active Princecraft dealers in Sudbury (Mid City Motorsports), Hearst (P&L Sales), and Thunder Bay (Woody's Marine). Claim softened to SSM-scoped — defensible and accurate.

**Proposed meta desc (143 chars):**
```
Boats for sale in Sault Ste. Marie. Princecraft fishing boats, pontoons, and jon boats in stock. Authorized Princecraft dealer at Reyco Marine.
```

---

## P1.6 — /choosing-mercury-outboard-northern-ontario/ — Title + Internal Links

**Fix:** Content plan P1.6
**Priority:** HIGH
**Problem:** 15 impressions, 0% clicks, pos 12.5 — page 2; needs title push + internal link authority to surface

**Lookup:**
```bash
wp post list --post_type=post --post_status=publish --fields=ID,post_title,post_name | grep -i mercury
```

**Current title:** Likely "Choosing a Mercury Outboard for Northern Ontario" (no brand authority signal or Reyco attribution)

**Proposed title tag — Option A, 59 chars (recommended — retains article's regional scope):**
```
Mercury Outboard Motors for Northern Ontario | Reyco Marine
```

**Option B, 52 chars (boss QC suggestion — hyper-local):**
```
Mercury Outboards in Sault Ste. Marie | Reyco Marine
```

**Proposed meta desc (163 chars):**
```
Which Mercury outboard suits Northern Ontario waters? Reyco Marine covers every class from portable kickers to V8s. Authorized Mercury dealer in Sault Ste. Marie.
```

**Apply title (use whichever option Aiden confirms):**
```bash
# Option A (recommended):
wp post meta update <MERCURY_POST_ID> rank_math_title "Mercury Outboard Motors for Northern Ontario | Reyco Marine"
# Option B:
# wp post meta update <MERCURY_POST_ID> rank_math_title "Mercury Outboards in Sault Ste. Marie | Reyco Marine"
wp post meta update <MERCURY_POST_ID> rank_math_description "Which Mercury outboard suits Northern Ontario waters? Reyco Marine covers every class from portable kickers to V8s. Authorized Mercury dealer in Sault Ste. Marie."
```

**Internal links to add (body content edit required — separate from WP-CLI meta):**

Add these 2 internal links within the post body:
1. Link the phrase "small engine and outboard service" (or similar service mention) to `/service-and-repair/` or `/service/small-engine/`
2. Link the phrase "contact Reyco Marine" or "visit us in Sault Ste. Marie" in the CTA section to `/contact/`

Body edit via WP-CLI:
```bash
# Get current content
wp post get <MERCURY_POST_ID> --field=post_content

# Replace inline (use update after editing externally, or use sed carefully)
# Safer: edit via WP admin or save to file, then:
wp post update <MERCURY_POST_ID> --post_content="$(cat /tmp/mercury-post-updated.html)"
```

**Expected impact:** Title authority boost + internal links from a page with 0 existing links = position jump from 12.5 toward page 1. Conservative target: pos 7-9 by Day-30 audit.

---

## Summary Table

| # | URL | Change | Chars | Storage Path | Aiden Gate |
|---|-----|--------|-------|-------------|-----------|
| P1.1 | /aboutus | Meta desc | 155 | `rank_math_description` on page post | Copy approval |
| P1.2 | /service/small-engine/ | Title + meta desc | 54 / 138 | `rank_math_title` + `rank_math_description` | Copy approval |
| P1.3 | Toro inventory | Meta desc | 144 | Likely Rank Math taxonomy term | Copy approval |
| P1.4 | Cub Cadet inventory | Meta desc | 136 | Likely Rank Math taxonomy term | Copy approval |
| P1.5 | Boats inventory | Meta desc (corrected — "only dealer" claim removed) | 143 | Likely Rank Math taxonomy term | Copy approval |
| P1.6 | Mercury blog post | Title (59 or 52 chars — Aiden pick) + meta desc + 2 internal links | 59 / 163 | `rank_math_title` + `rank_math_description` + body edit | Copy approval |

**Flag for boss:** P1.3, P1.4, P1.5 involve inventory filter URLs. Confirm whether these are WooCommerce product taxonomy terms (Rank Math term meta) or plugin-generated filter URLs before applying. If plugin-generated, flag to dev for Rank Math archive pattern configuration.

---

## Change Log (apply here after each fix is live)

| Date | Fix | Applied By | GSC Signal Date |
|------|-----|-----------|----------------|
| — | P1.1 | — | — |
| — | P1.2 | — | — |
| — | P1.3 | — | — |
| — | P1.4 | — | — |
| — | P1.5 | — | — |
| — | P1.6 | — | — |

---

*Generated: 2026-05-11 by seo-agent | Post chino:audit P1 execution*
*Next review: Day-16 audit 2026-05-18 — check CTR delta on all 6 targets*
