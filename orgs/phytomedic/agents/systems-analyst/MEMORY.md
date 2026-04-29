# Long-Term Memory

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
