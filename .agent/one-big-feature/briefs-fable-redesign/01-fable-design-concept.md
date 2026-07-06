# Clearworks Brief — Fable Design Concept: "The Founder's Daily"
> Produced by a real Fable design pass 2026-07-05. Brief site = /Users/joshweiss/code/briefs (publisher/build_dashboard.py + publish_brief.py), phone surface briefs-production-b399.up.railway.app. Fix IN PLACE — no rebuild, no migration to the (computer-only) fleet dashboard.
> NOTE: Josh said "my website is gold standard not Clearpath" — next session VERIFY palette against the live clearworks.ai site; the concept below sourced brand from the Brand v4 design-system doc + Clearpath tokens (which align on purple/coral/cream).

## STEP 1 — The real Clearworks brand (grounded, with paths)
NOT pink/navy, NOT "gold and cream." It is: **deep aubergine purple + single coral accent + warm cream paper + Inter only.**

Sources:
- `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/design-system/clearworks-brand-v4-design-system.md` — AUTHORITATIVE "Clearworks Brand v4" (Larry 2026-06-08), token JSON, type scale, components. Dup at `wiki/projects/clearworks-brand-v4-design-system.md`. Traced to `gws-security/templates/report.html` commit a1898c1.
- `/Users/joshweiss/code/knowledge-sync/raw/resources/brand/CLEARWORKS-BRAND-SYSTEM.md` — v1 (Mar 2026), same palette, voice ("Confident, Direct, Transformational, Peer-to-peer, Specific"), Inter, 8px grid.
- `/Users/joshweiss/code/knowledge-sync/raw/resources/brand/color-swatches.html` — `#2D1B4E`×11, `#FF6B5B`×8, `#F5F3F0`, `#FF8C6B`, `#E84D3A`.
- `/Users/joshweiss/code/clearpath/client/src/index.css` + `tailwind.config.ts` — `--primary` coral `#FF6B6B`, warm off-white bg, near-black plum sidebar, Inter, JetBrains Mono, radius 9/6/3px, hairlines.

Palette tokens:
```
--purple #2D1B4E  --purple-2 #3D2864  --purple-deep #1B1029
--coral #FF6B5B (THE accent, sparingly)  --coral-2 #E84D3A
--ink #1A1A1A --ink-2 #2C2C2C  --cream #F5F3F0 (page bg, never pure white)
--paper #FFFFFF (cards)  --muted #6B6B6B  --rule #DCD7CE
--ok #388E3C --warn #F57C00 --bad #D32F2F
Hero: radial coral glow over linear #2A1A40 -> #1B1029
```
Type/voice: Inter only (400/500/600/700), no serif. Body 16px/1.6. Signature: UPPERCASE coral eyebrows 0.22em tracking; oversized purple stat numbers tabular-nums -0.03em; 1px hairline rules; square corners (~2-3px), flat, no shadows. Voice: "a consulting report that reads like a design magazine."

## STEP 2 — Why the current site feels weak (audit, with lines)
1. **No `<meta viewport>`** (publish_brief.py:271-278) → renders at ~980px on phone. Bug #1, fix regardless.
2. Off-brand tutorial palette `#1a1a2e/#0f3460/#e94560` (publish_brief.py:22-110) + raw Bootstrap in CRM tab (build_dashboard.py:1811-1814). Zero Clearworks color.
3. System font stack not Inter (publish_brief.py:24).
4. 11 wrapping tab buttons (build_dashboard.py:35-47; TAB_CSS publish_brief.py:100-110) — sticky bar wraps 3+ rows on phone.
5. Everything is a bullet list (collect_today_tab build_dashboard.py:2697-2832) — dense prose, no glanceable numbers.
6. Emoji as UI (✅/❌ build_dashboard.py:232-233).
7. Three divergent inline CSS islands (base; Tasks :520-610; CRM :1852-1887) — inconsistent grays/radii/blues.
8. Desktop-document layout `max-width:720px;margin:40px auto` — blog frame, no app shell, no dark mode, no safe-area.

## STEP 3 — Concept: "The Founder's Daily" (a daily editorial issue, not an admin panel)
### IA: 11 tabs -> 4 thumb-nav destinations + drill-down
| Bottom nav | Question | Absorbs |
|---|---|---|
| **Today** (default) | What matters now? | Today (rebuilt) |
| **Work** | What's built + healthy? | Tasks · Dev Status · Fleet Health |
| **Business** | Money + people? | Deal Pipeline · Contacts · Meeting Debriefs |
| **Library** | Queued/learned/trending? | Content · Trending · Wiki · Session Analysis |
Old tabs -> in-page segmented sub-sections. Existing hash deep-links preserved.

Today (personal+business merged): 1) dated masthead + greeting; 2) STAT STRIP (Pipeline $ · Tasks · Open PRs · Fleet running — big purple tabular numbers, fixed positions); 3) Next up (hero calendar card + timeline); 4) Priorities (human-task check-rows, reuse existing drag/complete); 5) Needs attention (exceptions ONLY, coral alert cards — renders nothing if all clear); 6) Pipeline movement + latest debrief TL;DR.

### Layout/components (mobile-first)
Cream page; deep-plum hero slab w/ coral radial glow; single 16px column; fixed bottom nav w/ safe-area; viewport meta added. Cards white on cream, 1px #DCD7CE, 2px radius, flat; coral eyebrow headers. Numbers 40-48px purple tabular -0.03em + uppercase muted label. Status = brand pill tints (not emoji). Hairline rules; 2px purple section rules. Dark mode phase 2 (#1B1029). Coral discipline: eyebrows + top stat + alert borders + active nav ONLY.

### Before->after: Today (numbers into stat strip), Fleet Health (per-agent cards + CSS stacked bar), Deal Pipeline (vertical stage accordion, not side-by-side Bootstrap columns), Tab bar (4-item bottom nav).

### Ship order: (1) viewport meta + token re-skin (instant credibility), (2) IA regroup to bottom nav, (3) Today stat-strip front page, (4) dark mode. Changes localize to publish_brief.py CSS/TAB_CSS/_render_document_head + build_dashboard.py TAB_ORDER + 2 tab-local CSS islands — collectors/pipeline untouched. Self-host/@import Inter.

## Mobile mockup (self-contained HTML — save to a .html and open on phone width; NOT in repo)
See the full HTML in the handoff/transcript; key structure: hero (eyebrow "The Clearworks Daily · No.186" + "Saturday, July 5" + greeting) → 4-cell stat strip → Next up card → Priorities check-rows → Needs attention (coral alert + OK pill) → fixed 4-item bottom nav. Palette per tokens above. (Full HTML available in Fable agent output 2026-07-05; regenerate if lost.)

**One-line pitch:** your daily brief becomes *The Clearworks Daily* — a dated cream-paper, purple-and-coral editorial front page with your four numbers up top and a thumb nav below, instead of eleven navy tabs and a wall of bullets.
