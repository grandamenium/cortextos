# 00 — Planning Synthesis (completeness critic pass)

**Author:** architect (completeness critic) · **Date:** 2026-07-04 · **Status:** review artifact, no code.
**Scope:** the 5 specs in `specs-2026-07-04/` — WS9 (CRM consolidation), WS5 (knowledge/doc pipeline), WS10 (completeness/correctness layer), WS2 (verify-receipts claim gate), WS12 (better coding agent).
**Out of this batch (planned separately, creator-video track):** WS8 (model routing), WS11 (comms-worker architecture + per-agent digest). Not assessed here except where the others depend on them.

---

## 0. The one fact that reframes everything

These are **redo specs, not greenfield.** The first batched attempt already ran and PR'd: #717 (Batch B = WS5+WS9+WS10), #718 (Batch A = WS2+WS3+WS4+WS8), #719 (Batch C = WS6+WS7+WS12). **All three are CLOSED, not merged** (verified via `gh pr list`). The root-cause lesson recorded in `09-one-go-batch.md` and every spec's "conflict-bomb failure mode" line is the same: **broad-refactor workstreams collide (~80-file conflicts) when batched.** #717 was actually Opus-approved and build-green, but was closed rather than merged because A and C blew up around it and Josh's merge policy is one-reviewed-PR-at-a-time.

So the correct mental model for this batch: each of the 5 specs is deliberately re-scoped to be **small, additive, and independently mergeable in its own fresh clone.** The synthesis below is judged against that constraint — the biggest risk is not "will it work" but "will it stay in its lane."

The specs are well-grounded. I spot-checked the load-bearing claims: `src/bus/scope-guard.ts` + `src/utils/scope-guard.ts` exist (WS12 gap E shipped), the WS2/WS4/WS5/WS10 primitives (`verification-receipt.ts`, `claim-detector.ts`, `reconcile.ts`, `cron-state.ts`, `memory-lint.ts`) all exist, and the `codex-handoff` skill is genuinely absent from `templates/` on main (WS12's dangling-reference claim is real). The grounding is trustworthy.

---

## 1. Cross-cutting dependencies (who feeds whom)

**Hard dependencies (B cannot ship correctly before A):**

1. **WS5(a) fail-loud ingest → WS5(c) Clearpath export re-embed.** The export's whole safety story is "the ~2,700-row ingest is now fail-loud." If (c) runs before (a) lands, a partial/failed embed of the gold corpus silently reports success — the exact depletion-incident failure, now on the highest-value data. (a) is a hard prerequisite for the (c) RUN. The spec states this; it is correct and non-negotiable.

2. **WS10(b) R6 ledger depends on WS2 receipts + WS5(a) machine-readable errors.** R6's `ActionSignal` stream reads `verification-receipts.jsonl` (WS2 infra, already live) and its `cron_error_unreported` finding depends on cron-execution logs carrying real failure status. R6 correlating "claimed vs fired" is only as good as the underlying signals: if WS5(a) hasn't made ingest failures visible as events, R6 can't catch a silent kb-ingest. R6 is downstream of both WS2 (shipped) and WS5(a).

3. **WS10(a) graph-reindex cron + WS10(b) did-vs-claimed cron both land in `orgs/clearworksai/agents/larry/config.json`.** They share one file. They must be one config edit or they conflict with each other. The WS10 spec already bundles them — keep it that way.

4. **WS2 claim-gate hardens the send-telegram choke point that WS10(b) reads from.** WS2 emits `claim_blocked` / `claim_confirmed_override` events; R6 should treat a `claim_confirmed_override` as a *satisfied* claim (agent asserted verification) and a plain `claim_without_receipt` as an open one. **This coupling is not stated in either spec** — see Gaps §2.1. If R6 ignores WS2's new override event, it will re-flag claims WS2 already resolved (false positives, the exact WS2-lesson erosion).

**Soft / same-surface dependencies (no ordering, but shared blast radius):**

5. **WS9(c) omi-ingest and WS5(d) intel-extraction both bolt onto the crm `fireflies-ingest` cron / crm agent config.** WS9(c) adds an `omi-ingest` cron; WS5(d) adds an intel-extraction *step inside* `fireflies-ingest`. Different edits, same `crm/config.json` neighborhood and the same "single write surface" doctrine. They should be sequenced so they don't both rewrite the cron block in parallel clones (conflict-bomb-in-miniature). Also both depend on the same principle WS9(c) formalizes: `upsert-contact.py` is the sole contact writer. WS5(d)'s intel docs write to `knowledge-sync/raw`, not `contacts.json`, so they don't fight over the writer — but they do share the cron.

6. **WS9(b) canonical `entity_id` is the join key that a future WS5→WS9 or MMRAG-entity-linking would need.** WS5's exported Clearpath intel docs carry `fireflies_meeting_id` + `org_id`; WS9's `clearpath_ref` carries `clearpath_org_id`. These are the *same Clearpath identifiers*. Nothing in this batch links them, but WS9(b) is the workstream that mints the stable id both would key on. If entity-linking of meeting intel to CRM contacts is ever wanted (it's a natural phase-2), WS9(b)'s `entity_id` is the prerequisite. Flag as a seam, not a dependency.

7. **WS12 SCOPE_GUARD is the meta-dependency for this entire batch.** The reason this batch is 5 isolated specs instead of one is the conflict-bomb lesson. WS12 bakes SCOPE_GUARD invocation + worktree isolation into the *default* coding loop — i.e. WS12 is the durable fix for the failure mode that closed #717/#718/#719. Every other WS in this batch is *protected by* WS12 being in place. This argues WS12 should land early (see Sequencing), even though it produces no user-facing value itself.

8. **Shared Clearpath read-surface (WS5(c) + WS9(b)).** Both need to read Clearpath prod. WS5(c) reads `intelligence_extractions` via `DATABASE_PUBLIC_URL`; WS9(b) reads contact/deal events via "webhook or cursor — TBD" and notes a `clearpath-intelligence` MCP already exists (`deal-enrichment` cron calls `mcp__clearpath-intelligence__get_contact_intelligence`). **These two specs propose two different Clearpath access patterns for the same DB.** They should share one decision (see Gaps §2.2).

---

## 2. Gaps / missing pieces

**2.1 — WS2↔WS10 event contract is unspecified (real gap).** WS2 introduces new events (`claim_blocked`, `claim_confirmed_override`) at the send choke point. WS10 R6 consumes send-choke-point events. Neither spec defines how R6 treats WS2's new events. Without this, R6 will either (a) miss that a `require-confirm` override IS a claim that went out unverified-by-receipt, or (b) double-count it against a receipt that exists. **Add a one-paragraph contract** to whichever ships second: `claim_confirmed_override` = claim resolved-by-assertion (R6 may still flag as a "confirmed-without-receipt" soft finding); `claim_blocked` = claim never sent (R6 ignores). This is cheap to fix now and expensive as a false-positive flood later.

**2.2 — No single decision on the Clearpath access surface.** WS5(c) assumes `DATABASE_PUBLIC_URL` read. WS9(b) is genuinely open ("webhook or cursor?") and notes an intelligence MCP exists. This is listed as an open question in *both* specs independently, which means it could get answered two different ways in two different clones. **Consolidate into one Clearpath-access decision** (my read: the `clearpath-intelligence` MCP is already wired and proven for `deal-enrichment`, so it's the lowest-risk surface for WS9(b)'s push; the raw `DATABASE_PUBLIC_URL` read is fine for WS5(c)'s bulk export since it's a one-time SELECT). But someone has to own that these are consistent.

**2.3 — WS5(d) intel-extraction has no grounded prompt-catalog port plan.** The spec says "port Clearpath's `promptKey/promptLabel` catalog from `server/services/default-prompts.ts`" but doesn't confirm that file exists / how many prompts / whether they're Anthropic-model-specific. This is the L (largest) piece and the one most likely to balloon. It needs its own discovery pass before it's build-ready — the spec correctly defers it to last, but "port the catalog" is hand-wavy relative to the surgical precision of parts a/b/c. **Flag: WS5(d) is not yet build-ready; it needs a mini-discovery on the prompt catalog.**

**2.4 — WS9(c) Omi MCP reachability is an unverified assumption blocking the shard.** The spec honestly flags it: the crm agent's `.mcp.json` has only filesystem+sequential-thinking (both disabled), and the `omi` MCP is fleet-level. **Whether the crm agent runtime can actually call the `omi` MCP is untested.** If it can't, WS9(c)'s whole ingest path needs a different mechanism (a bus helper, or omi-ingest running as a larry/frank2 task that writes into crm). This is a build-blocker that should be resolved *before* WS9(c) is scheduled, not discovered mid-build.

**2.5 — No rollback/kill-switch story for WS9(a) sync-board flip.** WS2 has `CTX_CLAIM_GATE=off|warn|enforce` and WS10 has report-only-then-strict — both have graceful rollback. WS9(a) inverts a default that runs every 15 min against `pipeline.json`. It has an escape hatch (`SYNC_BOARD_STAGE_MODE=board_authoritative`) which is good, **but there's no stated plan for what happens to the board display during the window where CRM is authoritative but no forward-sync exists** (open question 2 in WS9). The board will show stale stages indefinitely. That's arguably fine (divergence log gives a receipt), but it's a *product* gap Josh should sign off on explicitly, not a technical one. The forward-sync (CRM→board) is punted to "the dashboard team" — which, given this is a solo-Josh fleet, means it's punted to nobody unless Josh schedules it.

**2.6 — WS10(a) graph-reindex corpus scope overlaps WS5(b) wiki-republish.** WS10(a) reindexes larry's `state/knowledge-map` corpus; WS5(b) republishes the `knowledge-sync` wiki. Both are "keep knowledge fresh" crons on similar cadences. WS10 Q1 explicitly asks "just knowledge-map, or also the wiki?" and defers to WS5. **As long as they stay disjoint (WS10=graph corpus, WS5=wiki markdown) there's no conflict** — but if the answer to WS10-Q1 is "also the wiki," they'd double-process. Keep them disjoint. Minor, already flagged, but worth a single explicit ruling so it isn't re-litigated per-clone.

**2.7 — WS3 (handoff-tail fidelity) is referenced everywhere but absent from this batch.** The roadmap sequence is WS1→WS9(a)→WS2→**WS3**→WS4→... WS3 was in the failed Batch A (#718). It is *not* one of the 5 specs here and *not* in the out-of-scope list (which only names WS8/WS11). **Where did WS3 go?** Either it's assumed done, deferred silently, or dropped. This is a tracking gap — WS3 (daemon appends live buffer at restart) is the fix for the memory-leak-at-handoff-tail problem (`feedback_fleet_memory_leak_and_handoff_tail`), which is load-bearing for certainty. It should be explicitly accounted for, not fall through the crack between "this batch" and "creator-video track." Same question, lower stakes, for **WS4** (fleet-reconcile in-scope redo) and **WS6** (context diet) — both were in the failed batches, both are in the redo list in `09`, neither is in this 5-spec batch. This batch is WS9/WS5/WS10/WS2/WS12; the redo list in `09` was WS4/WS6/WS12 + #718 minor fixes. **Only WS12 overlaps.** So WS4, WS6, WS3, and #718's minor fixes (WS2 stop-flag writer, WS3 JSON-envelope preview) are unaccounted for in the current spec batch.

**2.8 — No integration test spans two workstreams.** Each spec has a solid unit/regression test plan, but nothing tests the *seams* identified in §1 — e.g. "WS2 emits override event → WS10 R6 classifies it correctly," or "WS5(a) fail-loud ingest failure → R6 catches the silent cron." The seams are exactly where the false-positive erosion (the repeated fleet lesson) will hide. At least one seam-test (WS2→WS10 event classification) is worth adding.

---

## 3. Sequencing recommendation

**Governing principle from the failed batch:** isolate broad or shared-file work; parallelize only work that shares zero files. Each unit = one fresh clone, one PR, Josh reviews/merges each himself (his stated policy). WS12 lands early because it institutionalizes the isolation that prevents a repeat conflict bomb.

### Wave 0 — the safe, high-value, no-dependency singles (parallelizable, ship first)
These share no files and each kills active pain:
- **WS9 Shard A** (sync-board CRM-authoritative flip) — ~15 lines + tests, no data migration, kills the daily-clobber bug (`reference_sync_board_reverse_sync_reverts_reclass`). Highest value-per-line in the batch. Ships alone.
- **WS5 Part (a)** (fail-loud kb ingest) — surgical `cmd_ingest` change, opt-in flag so zero regression. **Prerequisite for WS5(c) run.** Ships alone.
- **WS2** (claim gate) — two new pure modules + one localized bus edit, ships in `warn` mode = zero behavior change. Ships alone.

These three can run **fully in parallel** (crm repo scripts / mmrag.py / bus.ts+new util files — disjoint file sets).

### Wave 1 — the isolation backstop + the correctness readers
- **WS12** (coding-agent defaults) — land here, not last. It's the durable fix for the conflict-bomb failure mode; every subsequent multi-file WS benefits from worktree-isolation + SCOPE_GUARD being the default. Additive doctrine + one skill, no runtime code. Depends on nothing. **Resolve Q3 (does the PreToolUse hook fire in the codex runtime?) before building the optional hook** — if it doesn't fire, ship doctrine-only.
- **WS10 (a)+(b)+(c)** — the completeness layer. (a) graph-reindex cron + (b) R6 ledger + (c) R8 memory harness. (b) depends on WS2 receipts (already live) + benefits from WS2's new override event landing first (§2.1), so **schedule WS10(b) after WS2 merges.** (a) and (c) have no such dependency and can go with the wave. **Add the WS2→R6 event contract (§2.1) to WS10(b) before building.**

### Wave 2 — the CRM canonical-id + new write surfaces (blocked on open questions)
- **WS9 Shard B** (canonical `entity_id` + Clearpath push) — blocked on the consolidated Clearpath-access decision (§2.2). Schema change under change-control. Ship after the access surface is decided.
- **WS9 Shard C** (omi-ingest) — blocked on Omi-MCP reachability (§2.4). Resolve reachability first; if unreachable, re-plan the mechanism before scheduling.

### Wave 3 — the gated prod-ops and the large port (last)
- **WS5 Part (c)** export RUN — Josh-gated + staging-first, and **hard-blocked on WS5(a) being merged first.** Build the export tool in Wave 1 (it's just a script), but the RUN is Wave 3.
- **WS5 Part (b)** wiki-cron de-dup — fleet-ops cron edit, Josh-gated, coordinate with WS10(a)'s larry config edit (§1.3) so they're one config change or clearly sequenced.
- **WS5 Part (d)** in-house intel-extraction port — the L. **Not build-ready** (§2.3) — needs a prompt-catalog discovery pass. Genuinely last.

### What parallelizes vs what serializes
- **Parallel:** Wave 0's three singles (disjoint files). WS12 + WS10(a)/(c) (disjoint from Wave 0 and each other).
- **Serialize:** WS5(a)→WS5(c-run). WS2→WS10(b). WS9(a) before WS9(b)/(c) (B/C build on the same crm store A stabilizes). WS10(a) and WS10(b) config edits into one larry-config change. WS5(b) and WS10(a) larry-cron edits coordinated.
- **Blocked pending answers:** WS9(b) (Clearpath surface), WS9(c) (Omi MCP), WS5(d) (prompt catalog). Don't schedule these into a clone until their blocker is resolved — that's how the last batch over-reached.

---

## 4. Biggest risks

1. **Repeat of the conflict-bomb (highest).** The last batch closed all three PRs because broad work collided. WS9(b), WS5(d), and any live-agent doctrine edit (WS12 §3.4) are the multi-file pieces most likely to sprawl. Mitigation: enforce the "one WS = one fresh clone = SCOPE_GUARD-checked diff" discipline WS12 itself codifies — and land WS12 early so it's the default, not an afterthought. This is why WS12 moves up in my sequence.

2. **False-positive erosion of the certainty signals (repeat fleet lesson).** WS2 (claim gate), WS10(b) (did-vs-claimed), WS10(c) (memory-correctness) are all *judgment* systems that flag the fleet's own behavior. The recorded history (`incident_false_crash_ratelimit_alerts_2026-06-29`, `feedback_comms_dedup_source_event_not_byte_identical`) is that these erode trust the moment they misfire. All three specs correctly default to warn/report-only with an opt-in strict flip — the risk is the **unspecified WS2↔WS10 event seam (§2.1)** causing R6 to re-flag WS2-resolved claims. Mitigation: pin the event contract + a seam integration test before WS10(b) enforces anything.

3. **Gated prod-ops run against prod without the fail-loud net (§0 dependency 1).** If WS5(c) export/re-embed runs before WS5(a) merges, a partial embed of the 2,700 gold rows reports success silently. This is the AuditOS-class incident (`incident_anthropic_api_credits_depleted`) on the highest-value data. Mitigation: hard-gate the (c) RUN on (a) being merged + the staging-collection dry-run the spec already requires. This is the single most consequential ordering constraint in the batch.

4. **Live-agent doctrine/config edits changing running behavior mid-flight.** WS12 §3.4 (edit live codexer SOUL/AGENTS), WS9(a) (invert a cron default), WS5(b) + WS10(a)/(b) (larry cron edits), WS9(c) (new crm cron) all mutate the *running* fleet. Each is individually low-risk and Josh-gated, but they touch overlapping agents (larry gets WS5(b)+WS10(a)+WS10(b); crm gets WS9(a)+WS9(c)). Mitigation: batch each agent's live edits into a single reviewed change per agent, use `cortextos restart <agent> --instance cortextos1` (single-agent, never a full daemon bounce per `reference_fleet_daemon_restart_guard`), and verify each cron fires once SILENT-OK before trusting it.

5. **Unverified external-surface assumptions blocking mid-build (§2.2, §2.4, §2.3).** Three specs carry an unresolved external dependency (Clearpath access pattern, Omi MCP reachability, Clearpath prompt-catalog). Each is honestly flagged as an open question — the risk is *scheduling the build before answering it*, which is precisely how WS4 over-reached last time (it built without a daemon-trigger design). Mitigation: treat these three open questions as build-blockers, not build-time discoveries. Answer them in Josh's one-go review, then schedule.

6. **WS3/WS4/WS6 falling through the tracking crack (§2.7).** They're in neither this batch nor the named out-of-scope set. If "fleet consolidation" is declared done after these 5 specs ship, three roadmap workstreams (including the handoff-tail memory-leak fix, WS3) silently drop. Mitigation: explicitly state their disposition — deferred, done, or a next batch — so certainty of *coverage* matches the certainty goal the batch serves.

---

## 5. Bottom line

The five specs are individually strong: well-grounded (I verified the load-bearing file claims), minimal, additive, each with a real test plan and honest open questions, each explicitly avoiding the broad-refactor conflict bomb that killed the first attempt. The *quality gap* is not within any spec — it's in the **seams between them** (the WS2↔WS10 event contract, the shared Clearpath surface, the shared larry/crm config edits, the WS5(a)→WS5(c) hard ordering) and in **coverage** (WS3/WS4/WS6 unaccounted for). Fix the seams and the tracking gap, land WS12 early as the isolation backstop, run the three no-dependency singles first, and hard-gate the prod-ops on their prerequisites, and this batch executes cleanly without a repeat of the #717/#718/#719 collision.
