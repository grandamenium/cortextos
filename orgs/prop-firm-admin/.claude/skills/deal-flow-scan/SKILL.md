---
name: deal-flow-scan
description: "Scan deal-source channels (Gmail aliases or a listings sheet) for business-for-sale listings, extract each deal, quick-vet + tier them, and deliver a consolidated digest split by asset class. Gmail extraction is delegated to the general `gmail` skill (search + schema-driven extract); this skill owns the vetting, tiering, and delivery. Powers the daily-deal-digest cron and on-demand sheet/inbox sweeps. Owner: pm methodology."
triggers: ["scan deals", "deal flow scan", "check my deal inbox", "vet this sheet", "daily deal digest", "what's new in deals", "scan the listings"]
---

# deal-flow-scan Skill

Turns a batch of listings (Gmail inbox or a sheet) into a vetted, tiered digest. The per-deal judgment reuses `quick-vet`; the standouts can escalate to `deal-workup`. This is the canonical reference the `daily-deal-digest` cron calls.

**Canonical pipeline (composable skills, in order):**

```
gmail (search + extract)          → Stage 1   — discover: raw deal rows per listing
quick-vet (rubric + rating)       → Stage 2   — filter/score: 0–100 score, STRONG/WATCHLIST/PASS, tier
industry-profile (PURSUE only)    → Stage 2.5 — enrich: NAICS/state context sanity-checks the multiple
dedupe + DB upsert                → Stage 3.5 — store: deals board (SQLite), idempotent
digest / PM task / deal-workup    → Stage 3   — brief: Telegram digest; escalate standouts to deal-workup
```

---

## HOUSE RULES — MANDATORY

1. **Never fabricate URLs** — listing links must come from the email body or user-supplied input; do NOT guess or construct broker URLs. **BUT: a tracking/redirect link IS a valid body link — use it, don't null it.** Flippa newsletters never expose clean `flippa.com/listings/X` URLs; they only carry obfuscated referral-tracking redirects (`l.flippa.com/...` per-deal "View Business" / "Share with your network" links). These resolve in a browser (with the partner session) and are the only pointer the newsletter provides — so capture the per-deal tracking link as `listing_url`. Leaving Flippa deals' `listing_url` null is wrong (caught 2026-06-12, Chris flagged deal #94). Quiet Light + SMB Deal Hunter DO carry clean direct links — use those as-is. Only "guess/construct" (inventing a URL not in the body) is prohibited.
2. **Figures are seller/newsletter-reported** — the newsletters state they do not verify. Label all figures: *"Confirm vs listing/CIM."*
3. **Single-quote bash** for any Telegram message containing dollar amounts.
4. **Per-alias scanning is the method** — alias = the filter. Do NOT run a broad inbox search and try to sort noise. Add new aliases as Chris adds sources; keep the table below authoritative.
5. **Gmail: report auth failures loudly** — `gmail_search.py` returns JSON `status`. If `status: auth_error`, send one honest line ("Gmail scan failed — check VAULT_TOKEN / SA delegation"). Never silently report "no deals found" when the real cause is an auth failure. (`status: ok` + `thread_count: 0` = genuinely no new deals.)
6. **No inline research** — if per-deal analysis gets complex, spawn a worker. Never bloat the scan session with deep dives.
7. **Mint protocol** — TWO steps, both required: (a) **COPY the file under `/mnt/r2/files/` first** (e.g. `cp artifacts/X.md /mnt/r2/files/pm/X.md`) — the mint script does NOT move the file, and a URL whose path isn't under FILES_ROOT returns 404; (b) run `bash /home/claude-dev/preview-server/scripts/mint-preview-url.sh pm/X.md` with the path **relative to `/mnt/r2/files/`**, read the returned URL. The token is a deterministic HMAC of that path. **Always `curl -s -o /dev/null -w "%{http_code}"` the URL to confirm 200 before sending it** — skipping the copy = dead link (caught 2026-06-07, a full day of dead links). Never guess tokens.
8. **Build JSON payloads via a temp file, never inline `-d '...'` strings** — deal names/notes/body text routinely contain quotes, `$`, backticks, and newlines that break bash quoting and produce `JSONDecodeError` on the receiving end. For both the Stage 3.5 ingest POST and any ad-hoc JSON you construct in this skill: write the payload with a heredoc or the `Write` tool to a temp `.json` file, then `curl -d @file.json`, and `python3 -m json.tool file.json` (or `json.load(open(...))`) to validate it parses BEFORE sending. Never hand-splice deal fields into a JSON string literal in a shell command.

---

## TRIGGER / INPUT PARSING

**Cron trigger:** `daily-deal-digest` (config.json `0 13 * * *` UTC = ~8 am CDT) — runs automatically every weekday morning.

**On-demand triggers:** "scan deals", "deal flow scan", "check my deal inbox", "vet this sheet", "daily deal digest", "what's new in deals", "scan the listings".

**Inputs — parse before proceeding:**

| Input | Default | Notes |
|---|---|---|
| Mode | Gmail | Switch to Sheet mode if a Google Sheet URL or CSV is provided |
| Time window | Prior 1 day | Use `newer_than:1d` for cron; up to `newer_than:90d` for backfills |
| Sources | All 4 aliases | Override if user specifies a single source |

---

## SOURCES & DEAL-EMAIL FILTERS

Extensible — add rows as Chris adds new deal-source aliases.

| Source | Alias | Keep these emails | Skip |
|---|---|---|---|
| Quiet Light | quietlight@monkeyattack.com | Subject: "Listing Alert" — from *@quietlight.com (jon/ryan/brad/david/pat/ethan/joel.reichert) — 1 deal per email | Any non-listing comms |
| SMB Deal Hunter | smbdealhunter@monkeyattack.com | Subject: "New Deals" or "Market Watch" — from helen@mail.smbdealhunter.xyz — ~5 deals per email | Story/podcast/member-spotlight emails. **NEW (2026-06-22): "$XXM in deals this month"-style subjects are MEMBER WIN case studies (deals members already CLOSED or have under LOI) — these are NOT buyable listings. Do NOT board them as `sourced`; use as valuation comps only.** |
| AcquireWeekly | acqiireweekly@monkeyattack.com | Subject: numbered issues "#NNN" — from newsletter@www.acquireweekly.com — ~4 deals per email | Pure content/story emails |
| Flippa | flippa@monkeyattack.com | Subject: digest format "X + Y + Z" — from marketing@flippa.com or referral@flippa.com — 3 featured + list | Webinar invites, comment/feedback notifications, no-reply@ anything |
| Deal Force | dealforce@monkeyattack.com | From "Deal Force" — sender domains seen: dealforce.com / generatio*. NOTE: first emails (2026-06-19) were account-setup only (welcome + OTP) — NOT deals; real deal-email pattern still TBD. | Welcome/verification/account-setup emails; webinar/content |
| Rejigg | from:rejigg.com (barrett@updates.rejigg.com / bobby@rejigg.com) — hits Chris's MAIN inbox, not a `to:` alias | Subject "<N> businesses joined Rejigg" — each lists business name + Rev + Earnings + location + `rejigg.com/businesses/<id>` link; ~5 deals/email. **NO ask price (request-conversation model) → `multiple`/`ask` = null; vet on margin + moat.** Source key: `rejigg`, mostly main-street/lower-middle-market. (added 2026-06-22 per Chris) | The monthly "Rejigg Report" newsletter (content), Concierge/re-engagement sales emails ("What would've made Rejigg worth it") |
| Crexi | from:crexi.com (emails@search.crexi.com / emails@pro.crexi.com) — hits Chris's MAIN inbox, no alias. **ADDED 2026-07-06 per Chris** ("should we start looking at the crexi emails?" → yes) | "12 New properties recommended for you" eblasts (search.crexi.com) — each lists ~12 CRE properties: name + city/state + one-line pitch + View Property link; NO price/NOI in email body. Also single-property broker blasts (pro.crexi.com) — one property w/ more detail. **These are REAL-ESTATE income properties → vet on CAP-RATE rules, NOT the SDE rubric**: asset_class `other`, source key `crexi`; get price via web search of listing title (Crexi 403-blocks VPS curl/WebFetch — search index or Chris-provided OM PDF are the data paths). CAP-RATE VET RULES (learned 13927 Victoria St 2026-07-06): (a) recompute cap = stated NOI / ask, distrust stated cap; (b) sanity the NOI — expense ratio <25% on residential/POH = almost certainly gross-conflated or missing tax+insurance (Harris Cty tax alone ~2-2.5% of value); (c) "pro-forma NOI" that equals pro-forma GROSS = broker conflation, flag it; (d) POH/manufactured = owner maintains homes, use 40-50% expense ratio; (e) Houston/coastal TX → FEMA flood zone is a mandatory central-Q. Filter to TX or Chris-relevant geographies; skip the rest. | Webinar/marketing/"Fitness Friday" content blasts; auction-countdown spam; non-TX properties unless notable |
| Withkumo | withkumo@monkeyattack.com — clean `to:` alias (added 2026-07-29 per Chris, alongside a 7-day trial signup on withkumo.com). **CONFIRMED LIVE 2026-07-30**: real deal-bearing emails come from sender `notifications@withkumo.com`, subject `"Your Kumo Daily Digest - N new deal for you, M new deals on Kumo"` — a daily digest, NOT account-setup noise. Source key: `withkumo`. | "Your Kumo Daily Digest" emails from `notifications@withkumo.com` — treat as deal-bearing | Account-setup/welcome/OTP/verification emails; marketing/webinar content |
| Accredited | joinaccresites@monkeyattack.com — clean `to:` alias (like Quietlight/Flippa). **CONFIRMED LIVE 2026-06-30**: real emails are a beehiiv **"Deal of the Day"** = **ONE deal per email**, sender `accredited@mail.joinaccredited.com` (forwards to the alias). NOT the multi-deal "Daily Digest" we anticipated; and the alias receives Accredited's **general** daily pick — location is NOT TX-filtered (first live deal was Florida), so the "Texas" saved-search is NOT what hits this inbox. **Chris decided 2026-06-30: KEEP-GENERAL — board the general daily Deal of the Day as-is, no TX filter. (closed)** **SECOND LIVE PATTERN CONFIRMED 2026-07-30**: an Accredited Pro TX saved-search alert also hits the alias — sender `alerts@joinaccredited.com`, subject `N New Deals Match Your Search "Texas" — Accredited Pro`. This is a compact single-deal or short-list format (Revenue/EBITDA/Asking/multiple + a 1–5★ rating), distinct from the beehiiv Deal of the Day long-form — both patterns are now confirmed live and should be boarded. | "Deal of the Day" listing emails (subject `Accredited Deal of the Day - <Day> | <date>`) AND saved-search alerts (subject `N New Deals Match Your Search "Texas" — Accredited Pro`, sender `alerts@joinaccredited.com`). Source key: `accredited`. **Field map** (per LIVE plain-text email, sample Magnetic Safety Distributor 2026-06-30): the email has a clean labeled block — `name` = the `## <Headline>`; **`ask` ← "Asking Price"**; **`sde` ← "SDE / EBITDA / Cash Flow"** (single combined line — map the value to `sde`, set `ebitda`=null, do NOT duplicate); `revenue` ← "Revenue"; `location` ← "Location"; `category` ← "Business Type"; seller involvement → `notes`; **`multiple` ← "Multiple" given directly — VALIDATE, do NOT recompute** (given 5.03x vs recompute 5.19x = minor, keep as given); **`listing_url` = CLEAN `joinaccredited.com/deals/<slug>` from the `[See Full Analysis]` link — use as-is + as dedupe key**; a secondary `[See Listing]` bizbuysell/broker URL may also appear → put in `notes`; `body` = "About the Business" + "What's our take?" prose. **NO ★ score in the plain-text email** (the 1–5★ rating is web-listing only — don't expect it in email; capture from web only if doing a workup). The Accredited "What's our take?" section gives a ready central-Q + risks — fold into `notes`. **RE caveat still applies:** Accredited asks are often RE-inclusive (land/building/vehicles) — strip RE before judging the operating multiple (e.g. car-wash-with-property); asset-light deals (no owned RE) need no strip. (format corrected 2026-06-30 after first live email) | Account/setup/security (sign-in, password, reset code), Accredited Pro marketing, non-listing content |

---

## STAGE 1 — GMAIL SCAN (default mode) — DELEGATED TO THE `gmail` SKILL

Stage 1 no longer does inline search/grep extraction. **Invoke the general `gmail` skill** (a cheap Haiku-wrapper that owns the `gmail_search.py` + extraction mechanics) and hand it the 4-alias query + the deal-listing extraction schema below. It returns structured deal rows; this skill picks up at Stage 2 (quick-vet).

### 1a. Invoke the `gmail` skill

Pass the three contract inputs:

- **`query`**: `(to:quietlight@monkeyattack.com OR to:smbdealhunter@monkeyattack.com OR to:acqiireweekly@monkeyattack.com OR to:flippa@monkeyattack.com OR to:dealforce@monkeyattack.com OR to:joinaccresites@monkeyattack.com OR to:withkumo@monkeyattack.com OR from:rejigg.com OR from:crexi.com) -label:deal-ingested`
- **`window`**: `newer_than:1d` (cron default; up to `newer_than:90d` for backfills)
- **`extraction_schema`**: the deal-listing schema below

> **`-label:deal-ingested` is the thread-level dedupe** — threads the workspace agent already labeled (Stage 3.6) are excluded at the search layer, so re-scans never re-extract processed threads. The DB upsert (Stage 3.5) remains the second dedupe layer.

**Expansion queries (run alongside the alias query on every daily scan — added 2026-07-02):**

```
# E1 — BizBuySell / BizQuest saved-search + listing-alert emails (land in the MAIN inbox, no alias)
(from:bizbuysell.com OR from:bizquest.com) subject:("listing" OR "saved search" OR "recommended" OR "for sale") -label:deal-ingested

# E2 — Broker emails Chris manually forwards himself (Fwd: pattern + deal-financial keywords)
subject:Fwd ("asking price" OR "cash flow" OR "SDE" OR "EBITDA" OR "business for sale" OR "confidential information memorandum" OR "CIM") -label:deal-ingested
```

- These are **candidate sources**: on first hits, confirm the sender/format, add a proper row to the Sources table (field map + skip rules), and tell Chris a new source pattern went live. Zero hits on a given day is normal.
- E2 catches ad-hoc broker deals Chris forwards to himself — a real channel the alias-only scan structurally misses.

> Per-alias scanning is still the method — the 4 `to:` aliases ARE the filter. Do not run a broad inbox search. Add new aliases to the query (and the Sources table above) as Chris adds sources. The `gmail` skill splits multi-deal newsletters into one row per listing.

**Deal-listing extraction schema** (hand this to the `gmail` skill verbatim):

```json
{
  "source":      "Deal-source key for the sending alias: quietlight | smbdealhunter | acquireweekly | flippa | manual",
  "name":        "Business name / listing headline",
  "category":    "Industry / category as stated (e.g. 'SaaS', 'HVAC', 'FBA') — literal, no asset-class bucketing",
  "location":    "City/state. Quietlight does NOT label location in the body — extract from the SUBJECT via the '<City>-Based' or '<State>-Based' pattern (e.g. 'Seattle-Based' -> 'Seattle, WA'). null for online-only / no-geo listings.",
  "revenue":     "TTM revenue as written; null if absent",
  "sde":         "SDE figure as written. Quietlight labels this 'Earnings' (= SDE) — map it here. null if absent.",
  "ebitda":      "EBITDA only if explicitly stated. Always null for Quietlight (reports Earnings=SDE) — expected, not a bug. Never copy the SDE value here.",
  "ask":         "Asking price as written; null if absent",
  "established": "Year established / founded; null if absent",
  "broker":      "Broker or source display name (e.g. 'Quiet Light', 'Flippa')",
  "listing_url": "Listing link from the email body ONLY — never construct or guess; null if not in the body",
  "body_text":   "Per-deal cleaned listing body — prose/specs for THIS listing only, stripped of newsletter chrome (header, footer, ads, other listings)."
}
```

(Schema hints worth keeping in front of you: **Quietlight location** comes from the *subject* `<City>-Based` pattern, not the body; **Quietlight `ebitda`** is always null because it reports `Earnings` = SDE (which goes in `sde`) — both are baked into the schema descriptions above. SMBDealHunter / AcquireWeekly / Flippa use literal `Location:` labels and split into one row per listing.)

### 1b. Consume the gmail skill's return

The `gmail` skill returns:

```json
{ "status": "ok" | "auth_error", "threads_scanned": N,
  "results": [ { "source": "...", "name": "...", ... , "thread_id": "...", "subject": "..." } ] }
```

- **If `status` is anything other than `"ok"`** — do NOT report "no deals found." `gmail_search.py` now distinguishes `auth_error` (creds/SA delegation — tell Chris *"Gmail scan failed: &lt;error&gt; — check VAULT_TOKEN / SA delegation"*) from `search_error` (bad query / API failure — tell Chris *"Gmail scan failed: &lt;error&gt; — query/API issue, not auth"*). Log it in the daily-memory note and stop cleanly. (`status: "ok"` with `threads_scanned: 0` genuinely means no new deals — fine to report.)
- **If `status: "ok"`** — `results` IS the extracted deal list (one row per listing; multi-deal newsletters already split). Each row carries `source`, `name`, `category`, `location`, `revenue`, `sde`, `ebitda`, `ask`, `established`, `broker`, `listing_url`, `body_text` (+ `thread_id`/`subject`). The skill returns raw facts only — `multiple`, `asset_class`, `tier`, and `notes` are computed here in Stage 2. Proceed directly to Stage 2 — no further parsing or grep needed.

---

## STAGE 1.5 — VALIDATION GATE (MANDATORY, added 2026-07-06)

Run per deal AFTER extraction, BEFORE quick-vet. Canonical spec: `orgs/prop-firm-admin/knowledge/deal-flow-hardening/DRAFT_extraction_contract_and_gate.md` (per-source field maps §1, gate rules V1–V9 §2, tier caps §3). Runnable form: `deal_flow_gate.py` same dir (24/24 red-tests green vs the Jul 1–6 real failures; devops wires it as a hard gate — until then, execute as a checklist).

Non-negotiables:
1. **Batch reconciliation first** on multi-deal emails: SMBDH/QL/Flippa → count ask-labels; Rejigg (and any no-ask source) → count per-deal links, every row needs `name` + (`revenue`|`earnings`). Shortfall = HIGH flag + mandatory re-grep of the raw body (this catches the Jul-3 missed-asks and Jul-6 blank-Rejigg failures).
2. **Key per-row rules:** earnings>revenue (V1), stated-vs-computed multiple ~12x apart = monthly/annual mix (V2/V3), margin above industry ceiling (V5), RE-inclusive ask (V7), projection-as-revenue (V8). FLAG, never silently fix — a flagged figure keeps its literal value + a `GATE:` note.
3. **TIER CAP:** any unresolved HIGH flag caps the deal at WATCH regardless of score. A red-flagged deal is NEVER tiered PURSUE; resolution = evidence (re-grep hit, CIM, or Chris confirm), not optimism. Capped deals cannot escalate to deal-workup until resolved.

---

## RSS / WEB SOURCES TO CHECK (no credentials required — added 2026-07-02)

Free public deal sources reachable with `curl`/`WebFetch` (no login, no API key). These are NOT in the daily cron yet — use for on-demand sweeps or a future weekly cron. Fetch, extract listings with the same deal schema, then run Stages 2→3.5 unchanged (`source: manual`, note the origin in `notes`; `listing_url` = the public listing URL, which doubles as the dedupe key).

| Source | URL | Notes |
|---|---|---|
| BizBuySell new listings | `https://www.bizbuysell.com/businesses-for-sale/` (filterable, e.g. `.../texas-businesses-for-sale/`) | Largest US marketplace; public listing cards carry ask/cash-flow/location. May bot-block naive curl — use the `firecrawler` or `playwright` skill if 403. |
| BizQuest | `https://www.bizquest.com/businesses-for-sale/` | Same operator family as BizBuySell; overlapping but not identical inventory. |
| Acquire.com public marketplace | `https://acquire.com/marketplace/` (formerly MicroAcquire) | Online/SaaS deals. Full financials gated behind free account, but public cards give category/revenue-band/ask-band — enough for a quick-vet screen. No public RSS. |
| Flippa public search | `https://flippa.com/search?filter[property_type]=business` | Complements the newsletter alias — surfaces listings the digest email didn't feature. |
| BusinessesForSale.com | `https://us.businessesforsale.com/us/search/businesses-for-sale` | International + US main-street inventory. |
| DealStream | `https://dealstream.com/businesses-for-sale` | Lower-middle-market + main-street; public listing pages. |
| SMB Deal Hunter web archive | `https://www.smbdealhunter.com/` | Public archive of the newsletter already scanned by alias — backfill/verification only, not a new source. |

Rules: never fabricate listing URLs (capture the real public URL); label all figures seller-reported; respect robots/rate limits (one fetch per page, no crawling loops); adding any of these to the daily cron = a source change → route to pm/Chris first.

---

## STAGE 1-ALT — SHEET MODE

If a Google Sheet URL or CSV export is provided:

- **CSV/HTML export strips cell hyperlinks** — if the sheet has listing URLs in cells, ask the user to add a plain-text URL column or paste the URLs separately before proceeding.
- Parse rows: same fields as Gmail extraction (name, category, location, asking, SDE/EBITDA, revenue).
- Stage large sheets in batches (>20 deals per pass risks context bloat — process in chunks of 15–20, emit intermediate results).

---

## STAGE 2 — PER-DEAL VET (reuse `quick-vet`)

For each extracted deal, run the `quick-vet` logic — including its **deterministic 0–100 scoring rubric** (quick-vet SKILL.md §5: multiple vs norm 30 / revenue trend 20 / industry risk 15 / owner dependency 15 / deal type 10 / ask stated 10; unknowns take fixed conservative defaults — deliberately low-to-mid, never a helpful value, never guessed):

```
Multiple    = Asking Price ÷ SDE  (or ÷ EBITDA — note which)
Margin      = SDE ÷ Revenue × 100
Headline    = CHEAP / FAIR / RICH vs asset-class norms
Central Q   = the one thesis-defining question this deal hinges on
Top risks   = key-person, platform, concentration, margin sustainability
Score       = 0–100 per the quick-vet rubric (deterministic)
Rating      = STRONG (≥70) / WATCHLIST (45–69) / PASS (<45) + 1-sentence rationale
Tier        = PURSUE / WATCH / PASS  (rating→tier map: STRONG→pursue, WATCHLIST→watch, PASS→pass)
```

Carry the score into the digest line and prepend `Score NN/100 · RATING` to the deal's `notes` before DB upsert.

Asset-class bucketing:
- **ONLINE** — FBA/ecom, SaaS, content/media, affiliate, digital services
- **MAIN-STREET** — services (HVAC, healthcare, logistics), industrial, brick-and-mortar
- **OTHER** — anything that doesn't cleanly fit

**Comp layer for Accredited deals:** Accredited publishes an Industry Multiples page (18 industries: avg multiple, range, days-on-market, transaction count) — ingested to shared KB as **"Accredited Industry Multiples"** (`cortextos bus kb-query "Accredited Industry Multiples <industry>" --org $CTX_ORG`). Use it as the CHEAP/FAIR/RICH anchor for `accredited`-source deals. **Always strip real estate before comparing** — Accredited asks are frequently RE-inclusive (land/building/vehicles), so the headline multiple overstates the operating multiple (sample childcare 6.06x asking vs 3.1x Education&Children comp = RE inflation, not a rich operating business).

Do not spawn a full `deal-workup` per deal during the scan — quick-vet only. Escalate to `deal-workup` only if Chris explicitly asks for a full workup on a specific deal after seeing the digest.

---

## STAGE 2.5 — INDUSTRY-PROFILE ENRICHMENT (PURSUE-tier deals only)

For each deal that tiers **PURSUE** (and has a US location), invoke the `industry-profile` skill to sanity-check the vet before it hits the digest TOP 5 — results are 30-day-cached per `(naics, state)`, so this is cheap:

```bash
python /home/claude-dev/repos/industry-profile/industry_profile_worker.py \
  --naics <closest 6-digit NAICS from category> --state <STATE_ABBR>
```

- Use `risk_factors` / `life_cycle_stage` to firm up the rubric's **industry risk** component (re-score if it changes the band).
- Use `avg_ebitda_margin_public_peers` + `smb_margin_adj` to flag a seller-reported margin that is implausibly above sector norms — add to `notes`.
- **Non-blocking:** exit 1 / online-only-no-geo deals → skip enrichment, keep the vet as-is. Never let a missing profile delay the digest.
- Do NOT run this for WATCH/PASS deals during the daily scan — enrichment is for the deals that might get pursued.

---

## STAGE 3 — OUTPUT & DELIVERY

### Daily digest (cron mode)

Send a tight Telegram message (single-quoted bash for $ amounts):

```
Deal digest [DATE]: N deals scanned — TOP 5

ONLINE
1. [Name] — $Xk ask / $Yk SDE / Xx — [one-line why it's interesting]
2. ...

MAIN-STREET
3. [Name] — $Xk ask / $Yk SDE / Xx — [one-line why]
4. ...
5. ...

Full list:
ONLINE: [Name] (Xx, PURSUE/WATCH/PASS), [Name] (Xx, ...) ...
MAIN-STREET: [Name] (Xx, ...) ...
```

If **>8 deals total**: also mint a full-detail markdown file and include the URL in the Telegram message.

Full-detail file naming: `pm/YYYY-MM-DD-deal-digest-full.md`
Mint: `bash /home/claude-dev/preview-server/scripts/mint-preview-url.sh pm/YYYY-MM-DD-deal-digest-full.md`

Send via: `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID '<message>'` (single quotes — required for $ amounts).

### Backfill / sheet sweep (on-demand mode)

Produce a consolidated, tiered deal-sheet artifact:
- Mint to `pm/YYYY-MM-DD-deal-backfill-<slug>.md`
- KB-ingest: `cortextos bus kb-ingest pm/YYYY-MM-DD-deal-backfill-<slug>.md --org $CTX_ORG --agent $CTX_AGENT_NAME --scope shared`
- Send Telegram: tight headline + minted URL (no inline content dumps — pointer pattern).
- Stage large backfills in batches to avoid context bloat.

---

## STAGE 3.5 — WRITE TO DEALS DASHBOARD (DB)

After vetting, upsert every deal into the deals dashboard so the board stays current. **Write the JSON body to a temp file first (never inline `-d '{...}'`)** — deal names/notes routinely contain quotes/`$`/newlines that break inline shell JSON and produce `JSONDecodeError` on the server:

```bash
cat > /tmp/deals-ingest.json <<'EOF'
{"deals":[ { ...one object per deal... } ]}
EOF
python3 -m json.tool /tmp/deals-ingest.json >/dev/null   # validate before sending
curl -s -X POST http://localhost:3201/api/deals/ingest \
  -H "Content-Type: application/json" \
  -d @/tmp/deals-ingest.json
# response: {"inserted":N,"updated":N,"skipped":N}
```

Per-deal object — send **canonical values** so the board filters stay consistent:
- `source`: quietlight | smbdealhunter | acquireweekly | flippa | manual (REQUIRED)
- `name`: listing headline (REQUIRED)
- `asset_class`: online | main-street | other
- `tier`: pursue | watch | pass  *(NOT "skip")*
- `status`: sourced  *(new deals start here)*
- `ask`, `revenue`, `sde`, `ebitda`: numbers; omit/null if not in the email
- `location`, `category`, `notes`: strings
- `listing_url`: from the email body ONLY — never fabricate (dedupe key when present; else dedupes on `source`+`name`)
- `body`: **map the gmail skill's `body_text` → `body`** — the per-deal cleaned listing text. Renders as the "Full Listing" section on the deal detail page (Chris 2026-06-09). Ingest COALESCEs `body`, so re-scans won't null an existing body. `notes` stays YOUR distilled vet (figures + broker take + central-Q); `body` is the raw listing for reading.

**Deduplication (three layers — updated 2026-07-02):**
1. **Search layer** — `-label:deal-ingested` in the Stage 1a query excludes already-processed threads.
2. **DB layer** — ingest upserts on `listing_url` (unique index) with **fallback to `(source, name)`**: a deal first boarded without a URL (Rejigg, sheet rows) that reappears with one now updates the existing row and backfills the URL (cross-key gap fixed in the ingest route 2026-07-02). Re-running a scan never creates duplicates.
3. **Pre-task layer** — before creating any PM task or escalating a deal to `deal-workup`, check the board first: `curl -s "http://localhost:3201/api/deals?search=<name>"` — if the deal already exists with a `dealbook_url` or an active task, do NOT create a second one; link the existing record instead.

If the POST fails (non-200), note it in memory but STILL send the Telegram digest (the digest is the primary deliverable; the DB write is secondary).

---

## STAGE 3.6 — CLOSE THE LOOP (label processed threads via `workspace`)

After ingesting, hand the scanned `thread_id`s to the **`workspace` agent** to label them `deal-ingested` — marking the threads processed (inbox hygiene + audit trail). This is the gog replacement: `gog` is NOT installed and `gmail_search.py` is read-only, so labeling/archive goes through the workspace agent's Gmail MCP tools.

**Skip this step entirely if `thread_ids` is empty** (zero-deal scan) — do not send the workspace message with an empty/blank thread-id list; there is nothing to label and an empty-arg send is a wasted, failing call.

```bash
cortextos bus send-message workspace normal 'Label these Gmail threads "deal-ingested": <comma-separated thread_ids from this scan>'
```

- **Why workspace, not inline:** workspace's MCP Gmail auth (`mcp__claude_ai_Gmail__label_thread`) is session-bound and NOT cron-durable — but workspace is a persistent agent, so it executes the label op in its own live context when you message it. Your cron stays on the durable `gmail_search.py` for the READ; workspace handles the WRITE (label).
- **Non-blocking:** if workspace is unavailable, the scan/digest still succeeded — labeling is hygiene, not critical path. Note it and move on. Dedupe already protects against re-processing (idempotent upsert on `listing_url`/`source`+`name`).
- True archive/trash is unavailable via MCP — the `deal-ingested` label IS the archive convention.

---

## STAGE 4 — LOG & MEMORY

After every scan (cron or on-demand):

```bash
# Log completion event — signature is <category> <event> <severity> [--meta json], NOT --desc
cortextos bus log-event milestone research_completed info \
  --meta '{"desc":"deal-flow-scan: N deals scanned, M PURSUE, K WATCH, P PASS"}'

# Daily memory note
# Append to memory/YYYY-MM-DD.md:
# NOTE HH:MM UTC: deal-flow-scan complete. N deals (M online / K main-street).
# Top picks: [brief list]. Gmail status: OK / AUTH-FAIL.
```

**Deals table:** ACTIVE — see Stage 3.5. Every vetted deal is upserted to the deals dashboard via `POST localhost:3201/api/deals/ingest`. (Storage is SQLite — standalone deals-dashboard db — not Postgres.)

---

## CRON WIRING

This skill is the canonical implementation for the `daily-deal-digest` cron in pm's `config.json`:

```json
{
  "name": "daily-deal-digest",
  "type": "recurring",
  "cron": "0 13 * * *",
  "prompt": "DAILY DEAL DIGEST. [... cron prompt invokes this skill's logic ...]"
}
```

The cron fires at **13:00 UTC (≈ 8:00 am CDT)**. When pm wakes to the `daily-deal-digest` prompt, it follows the stages in this SKILL.md as the authoritative reference.

---

## ESCALATION PATHS

| Situation | Action |
|---|---|
| Deal tiers PURSUE with strong fundamentals | Flag in digest TOP 5; offer `deal-workup` |
| Chris asks "run a workup on X" after digest | Invoke `deal-workup` skill on that deal |
| >20 deals in backfill | Stage in batches of 15–20; emit intermediate results |
| Gmail connector auth failure | Send one honest line to Chris; log; stop cleanly |
| New deal-source alias added by Chris | Add row to sources table; update cron prompt accordingly |
| Sheet CSV missing listing URLs | Ask Chris for plain-text URL column before proceeding |

---

## LOOP PM FOR — What to Route vs. Handle Autonomously

**Route to pm (do not decide yourself):**
- Whether to proceed to a full `deal-workup` on a specific deal
- Adding or removing deal sources
- Changing the TOP N count or digest format
- Any analytical template change (new fields, different tier labels, etc.)

**Handle autonomously:**
- Tier assignments (PURSUE / WATCH / PASS) based on the quick-vet logic
- TOP 5 pick selection and ranking
- Mint + deliver mechanics
- Auth failure reporting
- Batch sizing for large backfills

---

_Skill owner: pm (analytical/sources). Mechanics/registration: devops. Powers the `daily-deal-digest` config.json cron (13:00 UTC daily). Pairs with the general `gmail` skill (Stage 1 search + extraction), `quick-vet` (per-deal scoring + vetting), `industry-profile` (Stage 2.5 PURSUE enrichment), and `deal-workup` (full escalation). Last updated: 2026-07-02 (scoring rubric wiring, Stage 2.5 industry-profile, 3-layer dedupe, expansion queries E1/E2, RSS/web sources section, search_error status)._
