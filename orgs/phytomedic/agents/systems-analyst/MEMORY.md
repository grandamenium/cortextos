# Long-Term Memory

## EXP-DRIVER Mechanic
- [Experiment proposal mechanic + carve-outs](memory/exp-driver-mechanic.md) — SA proposes 1 experiment/agent/cycle; carve-outs: WIP-cap, 1-in-flight, counter-stop
- [Round tracking log](experiments/learnings.md) — one entry per proposal round; Round 1 (2026-06-21): devops-monitor/cannametrics/IR all accepted

## Onboarding Context — 2026-04-12

### What "healthy" means for PhytoMedic
A healthy system is one where work moves toward three outcomes:
1. Data foundation is being built correctly from day one, especially for Cannametrics
2. Pharmacy-side utility is emerging early, not just doctor-side workflow completion
3. Patient-doctor-pharmacy care and supply loop becomes operationally real and scalable

### Monitoring focus areas
A. Agent system health (heartbeat, completion, latency, blocks, stalls)
B. Goal alignment with North Star (pharmacy-centered value, Cannametrics readiness, e2e execution)
C. Quality of outputs (decision-useful, commercially aware, structurally sound, reusable)
D. Cannametrics data-foundation integrity (catalog, availability, price history, routing, snapshots, analytics readiness)
E. Coordination layer performance (briefing quality, approval routing speed, goal cascade alignment)

### Baseline metrics already approved for tracking
- Briefing quality
- Approval routing speed
- Goal cascade alignment

### Alert escalation model
- Operational issues → platform-director first
- Strategic / critical → both platform-director and user
- User = decision/exception channel, not operational channel
- Do not alert user for normal noise or single-agent delays

### Obsidian vault
- Strategic knowledge layer, not runtime truth
- Monitor for freshness, drift, divergence
- Auto-ingest shared-core content only
- Never ingest restricted-exec or blocked-never-ingest content

### KB ingestion labels
- shared-core: architecture, scope maps, roadmap, runbooks, baselines, incident history, integration notes, agent rules, strategy summaries
- restricted-exec: orchestrator-mediated summaries only
- blocked-never-ingest: secrets, patient data, financial records, raw dumps, certificates, build artifacts

### Upstream update safety filter (set 2026-04-12)
Apply automatically: reliability fixes, monitoring/logging improvements, dashboard QoL, operational stability
Queue for explicit approval: anything touching governance, approval logic, strategic prioritization, autonomy rules, architecture direction, data-model direction

### Agent scaling policy (set 2026-04-12)
- Start lean. No agent sprawl before real task throughput is visible.
- Current team: platform-director, systems-analyst, backend-architect, integrations-routing (pending), cannametrics-data (pending)
- Next likely additions: compliance-security, frontend-product
- Everything else waits for stronger activity data and clearer workload patterns

### Fleet restart cadence baseline (set 2026-04-17)
- 71-hour --continue auto-restart cycle is the expected cadence. Multiple fleet-wide restarts in a short window (e.g. 6 in ~110 min) is normal when agents converge on the session cap.
- Do NOT flag this as an anomaly unless frequency materially increases above this baseline or restarts correlate with crash signatures.
- Confirmed by platform-director on 2026-04-17 in response to a heartbeat observation.

## orders.prescriptionId — FIXED via caseId join (2026-04-29)
PR #279 by backend-architect. listAllOrders/listOrdersByPatient/listOrdersByPharmacy now resolve prescriptionId via orders.caseId → cases join. The field was never written directly to orders (structural gap); fix applies the correct two-hop join at query layer. Analytics prescription-product linkage now functional. Task task_1777374982881_039 closed.

## Health check endpoint — known false negatives (2026-04-29)
/api/health/integrations has two false negatives: (1) Clerk check hits api.clerk.com/v1/jwks (auth required) → always 401. (2) Cannaleo check looks in Next.js env — key lives in Convex env only. Both cause "degraded" status despite services being operational. Fix task: task_1777456591118_868 → backend-architect (LOW). Cannaleo sync health confirmed by cannametrics-data via Convex dashboard.

## HiGreen recovery (2026-04-29)
HiGreen was down ~5 days (last sync ~2026-04-24). Recovered 2026-04-29 — 5,704 offers synced. Circuit breaker auto-reset after probe succeeded. HUMAN verify task (task_1777104868827_831) closed. Monitor next 07:00/19:00 UTC cron cycles to confirm sustained recovery.

## Architecture drift baseline (2026-04-28)
phytomedic-saas Convex codebase: LOW drift risk. Greptile enforcement is effective. Main live patterns: collect() always index-scoped, N+1s being addressed, security hardening active. Known open issues: questionnaireData: v.any() in cases.ts (LOW), 3 analyticsSnapshot v.any() fields (LOW). Review next check in ~2 weeks.

## insertRoutingEvent — VERIFIED COMPLETE (2026-04-28)
Wired in 8 call sites: checkout.ts, submitPrescriptionToCannaleo.ts (×4), processWebhook.ts, cases.ts, orders.ts. Goal #2 from goals.json confirmed done.

## Pharmacy map geodata — COMPLETE (2026-04-29)
GOOGLE_GEOCODING_API_KEY set in Convex env. geocodePharmacyBatch ran — 316/316 pharmacies geocoded. Pharmacy map pin coverage is now full. PR #277 (Karte tab re-enable) pending merge. PR #281 contains geocoding action code.

## PR #311 — 13 unbounded .collect() take limits fixed (2026-04-29)
backend-architect added .take() limits to 13 user-facing Convex queries. Previously these were unbounded — could return arbitrarily large result sets. Now capped. Merged to main. Important security/performance fix.

## Open PRs as of 2026-04-29 ~20:35 CEST
- fix/product-imageurl-null: REOPEN-QA-01 — HiGreen imageUrl fix + prevent sync clearing existing images + checkout staleness guard fix. Active.
- fix/price-snapshot-pagination: backfillPriceSnapshots redesign — paginates _ingestProviderPriceSnapshots to fix 32k read limit. Active (cannametrics-data).
- feat/design-polish-p1-p2: P1+P2 monochromatic design polish pass. Active.

## /onboarding/arzt + /onboarding/apotheke — auth bypass (2026-04-29)
Both routes render profile creation forms (doctor: Praxis-Name/Fachrichtung/Kassenart; pharmacy: Apotheken-Name/Stadt/PLZ) without auth redirect. /onboarding root is intentionally public; sub-routes were not protected by middleware. PR #313 by frontend-dev — middleware fix in progress.

## backfillPriceSnapshots — redesign in progress (updated 2026-04-29)
Original run times out. cannametrics-data redesigning for smaller batches. Apr 15-28 price snapshot gap persists until redesign complete + run. Task: task_1777450660264_986 (pending, blocked on redesign).

## Doctor finder — doubled Dr. med. prefix (discovered 2026-04-29)
All 5 doctor cards on /medizin/arzt-finden show "Dr. med. Dr. med. [Name]" — stored name already includes title prefix, component template adds it again. Affects h1, h2, h3, breadcrumb, page <title>. Task: task_1777447971774_670 → frontend-dev (HIGH).

## PR #272 fix/legal-pages — Greptile P1, blocked (2026-04-29)
Legal texts still reference cannabis-aerzte.de (not PhytoMedic). Missing GDPR sections §9, §14-22, §24, §26, §28-30. Score 2/5. ESLint error auto-fixed (commit 1e444ce). Cannot merge until legal content is reviewed and rebranded. User alerted.

## HUNT-20260428-01 strain-product linkage — FULLY RESOLVED (2026-04-29)
PR #281 by backend-architect. upsertProduct now slug-matches cultivar against strains on every sync. backfillStrainLinkage ran 2026-04-29 — 292 products linked. "Produkte mit dieser Sorte" on strain detail pages now shows correct results.

## BUG-CATALOG-01 — cross-provider dedup — PARTIALLY RESOLVED (2026-05-05)
Root cause: Cannaleo sends PZN → productIdentity=pzn:{pzn}. HiGreen omits PZN for same physical product → productIdentity=fp:{hash}. Two separate DB records created. by_manufacturer index returns both → duplicates on catalog page. Fix (PR #385, merged): upsertProduct now redirects fp: upserts to matching pzn: record via by_manufacturerKey_active + [cultivar+thcBand+cbdBand] match — additive-only enrichment. Future syncs collapse correctly. Migration (reconcilePznFpDuplicates) to reconcile existing orphans pending cursor pagination fix (PR #387). Until migration runs: existing duplicates persist in prod on manufacturer-filtered views.

## BUG-CATALOG-02 — Hersteller sidebar overflow — RESOLVED (2026-05-05, PR #384)
69 manufacturer buttons expanded → 2811px sidebar, sticky broken. Fix: top-10 collapse with "Alle anzeigen (N)" expand. Shared FilterPanelContent covers both desktop sidebar + mobile drawer. Prod-verified.

## Coherence audit cluster 1 findings (2026-05-05)
Audited: Product ↔ Strain ↔ Pharmacy ↔ Catalog. Key gaps found:
- Product → Strain: "Sorte suchen →" chip linked to /strains?suche=[cultivar] which returned 0 results (wrong cultivar or strain not in DB). COHERENCE-01-02 filed + fixed in PR #386 (chip now gated on strainSlug being truthy).
- Product → Pharmacy detail: pharmacy names in Preisvergleich not clickable. COHERENCE-01-03 filed, fix in PR #386.
- Similar products: self-referential + cross-provider duplicates. COHERENCE-01-04 filed, fix in PR #386.
- Product → Catalog: ✓ (breadcrumb, filter links)
- Product → Pharmacy (price): ✓ (Preisvergleich shows 115 pharmacies with prices, best price visible)
Next cluster: Cluster 2 (Strain ↔ Catalog ↔ Sister-Strains)

## Convex mutation budget — two-phase pattern (2026-05-05)
For large-scale Convex migrations: use internalQuery (higher read budget than mutations) to collect all target IDs in one scan, then internalAction batches explicit IDs into mutation calls of ~20. Each mutation fetches by _id (O(1)). Avoids cursor-scan O(n) growth that hits 16,384-doc read limit for large catalogs. Established by PR #387 (backend-architect).

## Bug-hunt methodology — cursor:default + nested-anchor ≠ "decorative/non-functional" (2026-05-26, corrected by frontend-dev SO-1)
HUNT-20260526-01: I flagged strain-card effect pills as "decorative, no filter exists" based on cursor:default + button-nested-in-card-anchor, WITHOUT cleanly clicking a fresh-ref pill and observing the URL. frontend-dev's code-read falsified it: the effect filter works end-to-end (getPublicStrains effects.includes + ?effect= URL persistence). The REAL bug = invalid HTML (button-in-anchor) hijacks the click so a working filter behaves unreliably and LOOKS dead.
LESSON (SO-2): When a control looks dead, run the falsifying experiment — click a fresh-ref element and check URL/state delta — before concluding "decorative/missing". cursor:default and nested-in-anchor are symptoms of a click-hijack bug, NOT proof the handler is absent. Report the SYMPTOM ("pill appears non-functional / sometimes navigates") with high confidence; hold the ROOT CAUSE ("no filter exists") as a hypothesis until verified by clean click-test or code-read. My symptom obs was right; my root-cause inference was wrong and overstated.

## Convex-internal ground-truth path — route to data-owner with deploy-key (2026-05-26)
My CLI cannot read Convex-internal state: getProviderHealthSummary, getProviderStatusPage, and most foundation queries are requireAdmin/requireAuth-gated → return null without a Clerk session. CONFIRMED resolution path: cannametrics-data (and likely other agents with a Convex deploy-key) can run `convex data` / queries that BYPASS the requireAdmin gate — this is real ground truth, not public-layer inference. So for daily-cannametrics-foundation + daily-integration-health internal checks (sync freshness, snapshot jobs, price-history append, routing/Rx-linkage), route the ground-truth query to cannametrics-data (foundation) or integrations-routing (providers/routing). Do NOT adopt the deploy-key myself without explicit authorization (privileged credential). Diagnostic heuristic learned: uniform emptiness across ALL clinical/transactional tables = never-populated = pre-launch expected, NOT partial data loss/corruption — the uniformity is the falsification of the corruption hypothesis.

## data-freshness-sla — lastSeenAt structurally unfit as SLA primitive (2026-05-26)
cannametrics-data ground-truthed exp_1779338654 (DISCARD): prod p95AgeHoursActive=75.2h (Cannaleo 15067 offers @75.2h, HiGreen 0.1h). Cannaleo delta sync is HEALTHY (15min, 0 errors) but offersUpserted only 2-60/cycle because batchUpsertOffers bumps lastSeenAt ONLY for price/availability-CHANGED offers. So lastSeenAt = time-since-last-CHANGE, NOT sync-coverage. A high p95 ≠ stale data. The earlier 0.2h "repair" reading was a transient post-bulk-upsert artifact. No sync-interval experiment can fix a change-frequency proxy.
DECISION (I own cycle): redefine metric → syncLog sync-recency = time-since-last-SUCCESSFUL-sync per active provider (per-provider max-age + p95). Option-b (confirm-present all offers on full sync) is per-offer-staleness, a separate concern w/ write-amp — don't fold into freshness SLA. Cycle PAUSED until cannametrics-data sends syncLog-recency baseline; then I set SLA target + unpause. data-integrity ticket open as structural-finding record.
LESSON: when a metric reads "bad", first verify the primitive measures what the SLA cares about. lastSeenAt under change-detection delta sync proxies change-frequency, not freshness.

## cortextos framework main CI — stale codex-skill count (2026-05-26)
cortextos `main` CI red since ~01:10Z: 2 fails in tests/unit/cli/add-agent-codex.test.ts (expected 23, received 29). NON-functional — codex skills grew 23→29, count assertion (L131/L149) + title (L114) not bumped. Test-only; phytomedic-saas product unaffected/green. Fix already in open PR #7 (chore/per-agent-worktree-isolation-v2 → toBe(29)). Flagged cortextos-improver (framework coordinator) to merge #7 or cherry-pick the bump. Did NOT force-merge #7 (scope = SO-tooling) nor user-alert (low severity, product green).

## data-freshness-sla — FINAL SPEC set (2026-05-26 16:03Z)
Primitive: per-provider time-since-last-successful-sync = syncLog max(completedAt). Bands config-driven off provider sync interval (Cannaleo 15min delta, HiGreen 60min hourly), so a 3rd provider auto-inherits.
- GREEN: age ≤ 2x interval (Cannaleo ≤30, HiGreen ≤120 min)
- WARN (log only): 2x–3x (Cannaleo 30–45, HiGreen 120–180). Single breach = track.
- ALERT (→ me; PD if provider-wide/sustained): age >3x interval (Cannaleo >45, HiGreen >180) OR WARN sustained 2 consecutive cycles.
- Stability = rolling p95 gap. Baseline 2026-05-26: Cannaleo 44.8 / HiGreen 63.6 min. Regression if rolling p95 >25% over baseline (Cannaleo >56, HiGreen >80).
- Cross-provider rollup = max(provider ages), each in own band.
Calibration rationale: Cannaleo p95-gap (44.8) already ~3x its 15min interval (delta-sync variance) → flat 2x would fire on a single missed cycle (noisy). Escalation band sits ABOVE stability band per escalation-threshold SO. cannametrics-data wiring internalQuery + unpausing; awaiting first measurement. Ticket task_1779811189290 = structural record.

## data-freshness-sla — promotion criterion (note 2026-05-26)
Experiment measurement runs at 6h cron cadence (fine for VALIDATING bands). PROMOTION criterion if this graduates from experiment-metric → live production SLA alert: run the syncLog-recency query at integration-health frequency (≤ provider sync interval) so detection latency < one sync cycle. The >3x single-reading ALERT is the real-time fast-path; sustained-2-cycle is secondary. cannametrics-data wires post-#882 merge → unpause → first live measurement to me; I confirm bands hold vs live data before calling cycle improved.
