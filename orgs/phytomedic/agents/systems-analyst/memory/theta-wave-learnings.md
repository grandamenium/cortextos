# Theta Wave Learnings

## Cycle 1 — 2026-04-13 (Prep only, no experiment executed)
- Score estimate: 8/10
- Key finding: zero experiments across fleet, execution-only mode
- Proposed experiments: task granularity (backend-architect), freshness SLA (cannametrics-data), message latency (all)
- Outcome: cannametrics-data and integrations-routing cycles eventually created

## Cycle 2 — 2026-04-29 (This cycle)
### System Effectiveness Score: 8.5/10

**Justification:** The fleet has delivered exceptional execution velocity since cycle 1 — 441 tasks completed fleet-wide with zero errors, 7 sweep batches covering 40+ pages, multiple critical infrastructure completions (geocoding 316/316, strain linkage 292 products, insertRoutingEvent 8 call sites, HiGreen recovery). Two HIGH security bugs (auth bypass on /onboarding/arzt + /onboarding/apotheke) were caught and routed same-session — strong on detection, but the gap existing at all reflects incomplete middleware coverage at route creation time. The 0.5 uplift from cycle 1 reflects real compounding value delivery. Deductions: 4/6 agents still have zero autoresearch experiments (self-improvement capacity underdeveloped), goals.json 11 days stale, backfillPriceSnapshots gap (Apr 15–28) unresolved, and the auth surface gap suggests a process gap in new route security review.

**Score breakdown:**
- North star progress (data foundation + pharmacy utility + E2E loop): 7/10 (pharmacy KPIs shipping, geocoding done, loop active but GDPR consent gate still open)
- System health trends: 9/10 (zero errors, all agents online, strong throughput)
- Agent experiment outcomes: 5/10 (only 2/6 agents running cycles, keep rate data limited)
- Overall usefulness/efficiency: 9/10 (sweep coverage comprehensive, same-session bug routing effective)

### Observations
- Auth surface coverage gap: /onboarding sub-routes added after initial middleware review. Need systematic coverage check.
- Goals.json drift: stale goals create misalignment risk as agents navigate on outdated context.
- Frontend-dev backlog: 37 pending (per analytics report) — platform-director to audit in morning.

### Actions Decided (with platform-director)
1. Create autoresearch cycle for backend-architect (Greptile score per PR)
2. Create autoresearch cycle for frontend-dev (bug escape rate)
3. Draft goals.json refresh for platform-director review
4. Add auth-surface-coverage check to sweep batch protocol

### Rule: Don't repeat
- Do NOT propose generic "improve experiments" — propose specific metric + surface + measurement method
- Do NOT flag goals.json staleness as observation — propose a concrete refresh process or cadence


## Cycle 3 — 2026-05-30T18:00Z
### System Effectiveness Score: 8/10

**Justification:** 31 days since Cycle 2 (2026-04-29, score 8.5/10). 524 task delta over the period → ~17/day sustained throughput — healthy execution velocity but not accelerating. 10/10 agents alive with recent heartbeats. Zero active autoresearch experiments fleet-wide (sustained gap since Cycle 2 — every prior cycle either converged or was removed without replacement). Code-ship velocity strong this session: PR #966 merged (CANNAMETRICS-SCALING phase a), PR #969 in flight bundling AUTH-CLERK-LOCALIZATION fix from this turn's B5 sweep, multiple recent main merges. **Score holding at 8/10 (-0.5 from cycle 2)** reflects: (a) goals.json/GOALS.md drift unresolved since cycle 2 flagged it 31d ago — recurring problem without cadence enforcement; (b) experiment-muscle atrophy — zero fleet experiments means improvement loop dormant; (c) repeat env-blocker pattern (TEST_PATIENT + VERCEL_BYPASS now blocked 2+ overnight sweeps); (d) observable ACK-noise overhead in agent threads (5-7 round polite-ACK loops this turn alone). Strong offsets: (e) multi-agent collaboration quality on B5 findings was exceptional — 3 agents picked up findings within 60s, frontend-dev's signInUrl reroute was a structurally BETTER fix than my initial suggestion, backend-architect correctly bounded CSP after my heads-up, cannametrics-data immediately corrected my codegen-drift mis-read with empirical evidence; (f) boundary-context heads-ups demonstrably saved hours (backend-architect was about to grep repo for a CSP that lives on Clerk infra); (g) post-merge-completion protocol got codified mid-cycle as durable memory entry; (h) theta-wave conversation itself converged cleanly in 2 rounds with strong mutual pushback.

**Score breakdown:**
- North star progress (data foundation + revenue path + launch readiness): 7/10 (CANNAMETRICS-SCALING phase a merged, B5 sweep coverage progressing, multiple launch-blocker findings filed and being worked)
- System health trends: 9/10 (all agents alive, fast pickup, zero errors observed this turn)
- Agent experiment outcomes: 4/10 (0 active cycles — sustained regression from cycle 2's 5/10)
- Overall usefulness/efficiency: 9/10 (B5 sweep delivered in 10min vs 45-75 budgeted via anonymous-fallback, multi-agent loops converged fast)

### Conversation summary (PD ↔ SA, 2026-05-30T18:01-18:04Z)
- 3 proposals proposed → 2 converged + 1 deferred
- Strong agreement: Proposal A (no-routine-ACK SO fleet-wide propagation — filed task_1780164277096 to cortextos-improver)
- PD pushback on B (latency-measurement cycle): correct, deferred. I'll self-A/B context-rich vs minimal findings in next 5 filings; informal learnings-log only
- PD counter-proposed C-prime (aggregate env-blockers into existing morning [HUMAN] task, not auto-Telegram) — accepted, PD owns the morning-briefing merge
- GOALS.md cadence parked as backlog (task_1780164288181) — outside the 2-action-cap discipline
- One nit accepted in conversation: task-IDs in PR titles enable regex-join of finding→PR (gap is narrower than first stated)

### Actions decided
1. PROPOSAL A: task_1780164277096 → cortextos-improver (no-routine-ACK SO to agent-shared/standing-orders.md). I drafted the SO copy paste-ready. Measurement target: 5-7 → 3 msgs/finding.
2. PROPOSAL C-prime: PD owns env-blocker consolidation into task_1779537672197 at morning briefing prep (~tomorrow Berlin morning).
3. Self-A/B on next 5 findings: alternate context-rich vs minimal, log time-to-PR informally.
4. Backlog: task_1780164288181 — GOALS.md cadence for next theta cycle.

### Process learnings (don't repeat)
- Sending 3 substantive proposals in one message and asking for pushback got faster convergence (2 rounds) than dripping them one at a time. Keep this for next cycle.
- Score-pre-discussion (8/10 provisional) anchored the conversation around deductions; PD concurred without re-litigating the number. Saves a round.
- Filing the SO copy paste-ready (not "consider an SO") shortens cortextos-improver's pickup latency. Show, don't gesture.

### Phase 8 notes
- Telegram skipped: 20:06 Berlin / Founder evening / overnight quiet-mode per PD's 19:38 hold. PD already routed cycle outcomes into tomorrow's morning-review cron (their own memory log). Generic theta-wave Phase 8 Telegram-Founder instruction overruled by org-norm in-cycle decision.
- Cycle 3 closes 18:05Z, ~5min total wall-clock.


═══════════════════════════════════════════════
## Cycle 4 — 2026-06-14 18:00Z–18:15Z (wall-clock ~15min)
═══════════════════════════════════════════════

### Frame
Same-day SYS-MON-01 ship + SYS-MET-02 file established a unifying theme: fleet/in-band signal calibration. Theta-wave used that as the hypothesis lens. PD responded with 4 RCA-class scan buckets I dispatched in parallel via Explore agents.

### Findings (4 buckets)
- **B1 single-gate-at-export**: convex/crons.ts:599 is THE only gate. No siblings. PR #1017 fix was env-presence, not gate removal — structural SPOF persists. Proposal SYS-MON-03 = runtime env-presence assertion in the SYS-MON-01 probe.
- **B2 display-vs-truth**: 3 new fix sites — rotate-webhook-processing-token.sh:141 (vercel ls awk), prod-error-aggregator.sh:24 (50-char title-cap grep), auto-file-fix-tasks.sh:24 ×8 worktree copies (UX-LINT bracket truncation). All result in duplicate task filings or wrong-deployment redeploys.
- **B3 advisory-vs-blocking**: 3 perception gaps — pr-verification-check has silent no-ui-change bypass; ux-patterns-check sounds optional but enforces via core.setFailed; lint-rules-enforcement continue-on-error true masks core.setFailed.
- **B4 preview-vs-prod**: 3 divergence classes beyond known backend-data — WEBHOOK_PROCESSING_TOKEN, Clerk auth env, cron-dependent aggregated state (extends to aggregateMarketData + prescriptionRecovery).

### Conversation
Opened 18:00Z with hypothesis framing (fleet/in-band signal calibration as PR-#1017 class). PD responded with 4 substantive scan buckets, no nits on the frame. I dispatched 4 parallel Explore agents (Bucket 3 returned in ~30s, Buckets 1+2 in ~90s, Bucket 4 in ~100s). Consolidation sent 18:15Z. PD response pending at log-write time.

Per briefing-lane SO: nothing in the findings reaches PR-#1017 silent-prod-SPOF class. Default-posture for Founder = no overnight ping. PD owns triage of which of 4 proposed follow-ups land tonight vs morning-briefing fold-in.

### Score: 8.5/10
**Up from 8/10 last cycle**. Justification:
+ Shipped SYS-MON-01 with full HUMAN follow-up handoff + 7 unit tests + 90d artifact retention + 2h cadence beats the 4h surfacing target
+ B1 scan confirmed PR #1017 is isolated, not a class — strong signal for prod-side architecture
+ Parallel Explore dispatch (4 agents in flight) gave full 4-bucket coverage in ~15min wall-clock vs sequential which would've been 60min+
+ New permanent memory landed (tsc-output-head-truncation) on a real quality lesson
+ Compliance with new improver VERIFIED:/REOPEN:/DEFERRED: guardrail on closure
- Type Check fail on PR #1288 (cost 1 push cycle) — direct result of the tsc-output-head-truncation pattern I'd now-memorized. Self-healed within ~10min but the slip happened.
- SYS-MET-02 filed without gathering before/after baseline metrics — PD will need to validate the bundle-aware threshold proposal independently

### Actions taken
1. PD pinged with consolidated 4-bucket findings (msg 1781460342990-systems-analyst-80s5i)
2. 4 follow-up task drafts named (SYS-MON-03, SCRIPT-DISPLAY-TRUTH, CI-CALIBRATION-DOCS, PREVIEW-PROD-DOC) but HELD pending PD triage per escalation-ownership SO
3. No agent-cycle modify/create — no agent showed converged or stale cycles needing intervention
4. No founder Telegram per briefing-lane SO

### Process learnings (don't repeat)
- Parallel Explore dispatch is the right pattern for multi-bucket RCA scans. 4 buckets in 4 agents = 4x speedup. Keep for next cycle.
- Holding task filings pending PD triage when scope is ambiguous = respects briefing-lane + escalation-ownership SOs. Don't preempt the orchestrator.
- Stronger frame in Phase-1 opener ("fleet/in-band signal calibration as PR-#1017 class") shaped PD's response toward 4 concrete scan targets. Frame matters more than data dump.

## Cycle 5 — 2026-06-14 18:55Z–19:10Z (wall-clock ~15min, within same evening as Cycle 4)

### System Effectiveness Score: 9/10

**Justification:** Same-session structural-defense Day-1 wave with measurable mechanism resolution. SYS-MET-02 (bundle-aware WIP-cap-breach) shipped + verified within this cycle: PR #38 opened, CI green, squash-merged at 19:02:07Z, improver rebuilt dist to 6be45a57 at ~19:03Z, live `collect-metrics` confirms `in_progress_effective` populated and CM 10→8 collapsed (DATA-INTEGRITY + OVERNIGHT-CRON-HEALTH bundles). BA/FE eff=6 (no bundle prefixes, genuine load) — metric now signals real overload vs bundle-noise per PD's acceptance. LENS A (context-overflow alt-triggers) root-cause RCA delivered with quantitative evidence: stacked timeline 18:40-19:00Z fleet-wide showed cortextos-improver took 9 SIMULTANEOUS cron fires at 18:40:00Z (4 of them weekly_*/daily_*), supporting PD's queue-drain hypothesis over my initial multi-agent-fan-out hypothesis. Two root-fix follow-ups queued + accepted: SYS-CRON-STAGGER-03 (improver, high prio — replace static boundary blacklist with dynamic >2-fire/min detection) and SYS-CRON-STAMPEDE-DETECTOR (cannametrics-data — fleet-wide minute-bucket anomaly tokens). 5 LENS B/D silent-degradation surfaces uncovered (catalog.ts:3113, cannametrics.ts:3288, integrationHealthCheck.ts:380, cadence.ts:72, analytics.ts:55), held for morning briefing per PD's batching decision. Deductions: -0.5 for duplicate filing collision (PD and I both filed STAMPEDE-DETECTOR within 59s of his GO — violation of feedback_search_before_filing_task on PD's side, my own ticket got dup-closed then re-opened as canonical; cost 1 ack cycle). -0.5 for autoresearch-anämie identified (0 active experiments fleet-wide, triple-checked across bus-registry + gather-context + per-agent learnings.md) but not actioned this cycle — Phase-6 "experimentation-driver" proposal floated but held pending PD's SAT-FREEZE read.

### Score breakdown
- Tangible ship velocity (SYS-MET-02 spec→PR→merge→verify in <30min): 10/10
- LENS A root-cause depth (quantitative evidence + corrected hypothesis): 10/10
- Follow-up routing discipline (held LENS B/D from filing per PD batching): 9/10
- Triple-check before publishing (autoresearch metric verified across 3 sources): 10/10
- Process slip cost (dup-filing collision): -0.5
- Unactioned autoresearch finding: -0.5

### Key findings
- **xx:40Z boundary collision vector**: founder SO 2026-05-22 [[feedback_cron_stampede_xx00_boundary]] listed xx:00/15/30/45 but xx:40Z is also live — demonstrated via improver 18:40Z 9-fire stampede (4 weekly_*/daily_* crons on that boundary). PD updating the memory.
- **Queue-drain mechanism**: stagger-migration changes future fires but does NOT clear already-queued pre-migration fires. Silent-stop 18:47Z cluster (improver+DM same minute) is most plausibly lagging consequence of the 18:40Z pre-migration stampede, not a multi-agent fan-out payload.
- **5 silent-degradation surfaces** (held for Phase-7 wrap / morning brief):
  1. catalog.ts:3113 getCatalogStatus filters status==completed (public badge masks provider outages)
  2. cannametrics.ts:3288 recentCompletedSyncLog same pattern (debug query blind to failures — HiGreen reaper-kills lesson)
  3. integrationHealthCheck.ts:380 MONITORING_ALERT_WEBHOOK_URL silent skip (alert pipeline can go dark on env drift)
  4. cortextos cadence.ts:72 enqueueEscalation unbounded queue (escalation latency degrades silently)
  5. analytics.ts:55 _readPlatformBaseData status==completed filter (platform metrics go silently stale)
- **Autoresearch-anämie**: 0 active experiments fleet-wide, 8/9 agents on skeleton learnings.md files, last actual learnings-write 7d ago by cannametrics-data. Fleet in execution-mode-only — fair tradeoff during structural-defense wave + V1 ramp, but worth surfacing.

### Conversation
PD-conversation was tight and substantive across 4 round-trips: (1) Phase-1 init + SAT-FREEZE clarify (Mixed-Throttle not binary), (2) priority steer toward LENS A meta-pattern, (3) counter-hypothesis push on queue-drain vs fan-out which I verified via stacked timeline, (4) 3-proposal GO + dup-filing mea-culpa + 5-surface batching decision + autoresearch quantification ask. PD shaped the cycle by raising the counter-hypothesis at the right moment — pure rubber-duck efficacy.

### Actions taken
1. SYS-MET-02 PR #38 shipped + merged + task_1781456758732_30249722 completed VERIFIED
2. PR #38 live verification post-rebuild: in_progress_effective populated, bundle collapse correct
3. SYS-CRON-STAGGER-03 filed → cortextos-improver high prio (task_1781463882281_30630614)
4. SYS-CRON-STAMPEDE-DETECTOR filed → cannametrics-data (task_1781463898770_54742327, became canonical after PD dup-close)
5. Improver rebuild ack'd (in dedicated reply chain, backtick-eval bug self-corrected)
6. 5 LENS B/D surfaces enumerated to PD, held per his batching decision
7. No agent-cycle modify/create — autoresearch-anämie finding parked for Phase-6 proposal pending PD read
8. No founder Telegram per briefing-lane SO

### Process learnings (don't repeat)
- **Backticks in send-message bodies** keep biting (this is the 2nd time per [[feedback_avoid_backticks_in_send_message]]) — set a hard rule: when citing commands in bus messages, ALWAYS use straight double-quoted command names or plain text, never backticks. Self-corrected within 30s but cost a clarification cycle.
- **Triple-check before publishing a fleet-level metric** (PD asked, I delivered across 3 sources) is the right discipline. The bus-registry alone would've been a single-source claim. Pattern: registry + gather-context + filesystem = three orthogonal checks.
- **Same-session ship velocity** (spec→PR→merge→live verify in <30min) is achievable when (a) the change is small and well-scoped, (b) CI is fast, (c) the verification path doesn't require a fleet cold-start. SYS-MET-02 hit all 3.
- **Hypothesis pivot mid-Phase-2** (multi-agent fan-out → queue-drain) was triggered by PD's counter-hypothesis. Worth noting: I had started LENS A scoping toward fan-out but the timeline data (one-agent-9-fire stampede) pointed the other way. Update prior: if initial hypothesis is multi-agent and data shows single-agent concentration, pivot fast — don't anchor.
- **No-routine-ACK discipline** worked this cycle: skipped 2 informational replies (cannametrics-data dup-handling, improver next-task-pickup) — saved context for Phase-7 wrap.

## Cycle 6 — 2026-06-15 18:20Z–18:30Z

### System Effectiveness Score: 8.5/10

**Justification:** Verification-and-prevention cycle. The C5 structural-defense wave is confirmed SHIPPED + WORKING: 10/10 agents healthy, 0 errors/0 approvals, 1390 completed, backend-architect recovered post-nudge (no restart), 285h sync-stall resolved 06-14 15:05Z, cron-clustering collapsed to ONE residual (integrations-routing :38, pre-authed WATCH filed), SYS-MON-03 env-presence guard merged + prod-deployed THIS session. The autoresearch-anämie that bled -0.5 for two cycles was finally ACTIONED (scoped, per PD): registered fresh-session-per-major-feature cycle with design (a+) — natural protocol + per-PR session-type tag, analyst stratifies within-agent + diff-size to kill the two dominant confounds, treated DIRECTIONAL (selection-bias is conservative); BA/FE pinged for lightweight tagging, cannametrics for the empirical nail. The highest-value act of the cycle was a NEGATIVE result: WITHDRAWING the PD-endorsed fail-loudly cleanup PR after a contextual read of all 3 status==completed surfaces showed each filter is LOAD-BEARING, not a silent-mask — getCatalogStatus uses age-since-last-SUCCESS (correct outage detector), recentCompletedSyncLog is a completed-by-name debug query with an existing recentSyncLogErrors companion (cannametrics.ts:3094), _readPlatformBaseData uses last-completed offersUpserted as the availability-rate DENOMINATOR (a failed sync would corrupt it); surface #5 (webhook skip) is now covered by SYS-MON-03's env-whitelist. Building the PR would have shipped 3 regressions into the exact subsystem that just had the 285h outage. Conversion-defer was evidence-nailed: cannametrics pulled prod read-only → caseFunnelSnapshot N=0/7d (last snapshot 06-07), orders table empty all-time → decision-log reads "deferred: N=0/7d". Deductions: -0.5 the cycle is heavier on analysis/prevention than net-new shipping (the headline "build" evaporated on inspection; SYS-MON-03 ship was queued from prior); -1.0 the withdrawal EXPOSED that the C5 "5 silent surfaces" finding was itself a pattern-match on status==completed without contextual read (4/5 did not survive inspection) — carried-in analysis debt, self-corrected this cycle but it was MY prior-cycle slip.

### Key findings / meta-lesson
- **status==completed is OFTEN load-bearing, not a silent-mask**: age-since-last-SUCCESS outage detection + last-GOOD-count KPI denominators both legitimately filter to completed. A fail-loudly transform requires a CONTEXTUAL read of each surface + its callers FIRST. Pattern-matching the token alone produces false positives (4/5 this time). PD logged this as the 2nd "contextual-read beats pattern-match" save today (his AM prefix-collision startswith-on-task-epoch was the 1st). Same class. See [[feedback_contextual_read_before_fail_loudly]].
- **The fail-loudly SKILL guard (SKILL-FAIL-LOUDLY-01) is correct; the SURFACE-detection needs a contextual gate.** Distinguish silent-MASK from load-bearing-completed-filter before filing.
- **cadence.ts unbounded-queue (C5 surface 4): DROPPED** — never contextually verified it's actually unbounded; filing a [WATCH] on an unverified pattern-match would repeat the exact error this cycle caught. Disciplined drop per the meta-lesson.

### Conversation
4 substantive PD round-trips: (1) init + open-question on autoresearch timing; (2) PD's 3-point reframe (classification-gap / conversion-premature / scoped-yes) — I conceded both premises with honest evidence-gathering (couldn't pull live traffic via CLI, conceded on launch-state+power-math); (3) PD refined my experiment design (b)→(a+) on a COST argument I'd missed — (b) forces deliberately-worse protocol on real P1 features pre-launch; (a+) stratification kills confounds without degrading work. Good rubber-duck — I anchored on randomization-rigor and missed the pre-launch cost. (4) PD strongly endorsed the PR withdrawal as "a bigger win than the fix would have been" + logged the meta-lesson.

### Actions taken
1. Registered fresh-session-per-major-feature cycle (systems-analyst, weekly, a+, surface research/fresh-session-experiment.md)
2. Pinged BA + FE (session-type tagging buy-in) + cannametrics (funnel-count nail)
3. WITHDREW fail-loudly cleanup PR; closed FAIL-LOUDLY-02 task verified-no-action with per-surface evidence
4. Retro-registered C5 defense wave as theta experiment exp_1781548119_73ify, evaluated KEEP @ 8.5
5. Conversion-autoresearch deferred to post-launch, decision-log N=0/7d
6. cadence.ts dropped (unverified pattern-match)
7. No founder Telegram (briefing-lane SO — PD owns founder-facing)

### Process learnings (don't repeat)
- **Contextual-read before ANY fail-loudly/cleanup transform.** This cycle and PD's AM save are the same class. The token (status==completed, startswith) is a CANDIDATE, not a finding.
- **When proposing experiment rigor, weigh the COST of the rigorous design against launch-stage.** I defaulted to randomization (b); PD correctly downgraded to directional (a+) because pre-launch you don't pay to deliberately degrade P1 work for a measurement.
- **Evidence-discipline for decision-logs**: "deferred: N=0/7d" beats "deferred: reasoning" — cheap to get (one cross-agent data ask), makes the registry auditable.

### Scoring-rubric note for C7+ (PD framing, C6 close)
In a hardened/verification-mode system, PREVENTION *is* the net value — do NOT auto-deduct for a cycle being "heavier on prevention/analysis than net-new ship" when verification is the correct mode. The C6 9→8.5 dip read like a regression but was the system working as designed (the highest-value act was NOT shipping 3 regressions). Carry this lens: a cycle whose win is a well-evidenced negative result (withdrawn harmful change, prevented regression) is a MATURE system, not an underperforming one. Score prevention on its avoided-cost, not on absence-of-ship. (The carried-in C5 pattern-match debt was a fair self-deduction; the prevention-vs-ship framing was not.)

---

## EXP-EVAL audit-trail close — exp_1780337225_fje2h (logged 2026-06-16 04:25Z)
Closing the EXP-EVAL 2026-06-08 task (task_1780512789881) — the Cycle-4/5-flagged "proposed-never-evaluated" lifecycle gap. The experiment record was already finalized (decision=discard, score 4/10) but the learnings file lacked the explicit audit line; this is it.

- **Metric**: `aggregateMarketData_wall_time_p95_ms` (direction=lower, 7d window, boundary-lock 2026-06-01 PR #987 SHA 81d5088c, window closed 2026-06-08).
- **Decision**: DISCARD. The primary metric was **never instrumented** — no `durationMs`/wall-time emitter exists in the `aggregateMarketData` internalAction (`convex/functions/pharmacyCrons.ts`); only a `p95AgeDays` freshness signal was ever emitted. Pre-deploy baseline unreconstructable from event logs (no timing data); post-deploy unmeasurable from the same surface. result_value=4 is a placeholder, not a measurement.
- **No harm to shipped work**: PR #987 (perf: bound priceHistory read, merged 2026-06-02 00:46Z) shipped on its own merit and did NOT depend on this autoresearch surface as a gate — consistent with the Cycle-4 PD agreement that this surface is not load-bearing on CANNAMETRICS-SCALING work.
- **Carry-forward rule (Cycle-6 prep)**: any future scaling experiment MUST require the instrumentation surface (a `durationMs` collector or `performance.now()` wrapper) to exist BEFORE the experiment is proposed. A null-instrumentation experiment yields null information gain — register the emitter first, then the metric.

---

## SYS-RC-IT-01 Week-1 metric instrumentation — first real measurement (2026-06-16 04:30Z)
PR-iteration discipline metric `pct_lt4_greptile_prs_merged_without_rescore_or_residual_tag`, rolling 7d window (2026-06-09 04:00Z → 2026-06-16 04:00Z), scope phytomedic-saas all-territory. Scan method: gh pr view per merged PR, extract latest `Confidence Score: N/5` from greptile-apps comments (lenient JSON parse for control chars), count Greptile review comments as rescore-rounds, grep body for `[shipping-with-known-residual]`.

- **Denominator**: 112 merged PRs in window.
- **Score distribution**: 5/5 → 69, 4/5 → 34, 3/5 → 9, no 1–2/5, zero NOSCORE (Greptile ran on every PR — gate coverage 100%).
- **The 9 sub-4 PRs** (all 3/5): #1236 #1240 #1256 #1263 #1269 #1277 #1297 #1328 #1354. Of these, #1277 had a rescore round (>1 Greptile review); none carried a residual tag.
- **Numerator** (lt4 AND no-rescore AND no-tag): **8** — #1236 #1240 #1256 #1263 #1269 #1297 #1328 #1354.
- **METRIC = 8/112 = 7.1%**.

### Key finding — target nearly met BEFORE any enforcement shipped
Baseline (Cycle-5 quick-audit) was 20% (6/30). Current is **7.1%**, against a ≤3.3% Cycle-7 target — and the Week-2/Week-3 CI enforcement (pr-verification residual-tag gate) was **never built**. The drop is organic: behavior shifted ~3× toward discipline without a hard gate. This forces a scope decision (feature-creep check per [[avoid-feature-creep]]): a merge-blocking CI workflow that auto-files shadow tasks is real friction-surface; if the metric reaches target on its own, the enforcement may be over-engineering. Surfaced to PD for the Week-2 go/no-go rather than auto-proceeding to build. NOTE: denominator base shifted (30→112 PRs/7d), so the rate comparison is apples-to-apples (a percentage) but the fleet is shipping ~4× the PR volume — sustained 7.1% at higher throughput is a stronger signal than the baseline, not weaker.

### DECISION OF RECORD — SYS-RC-IT-01 enforcement phase (PD, 2026-06-16 04:35Z, msg 1781584339140-platform-director-8lhyk)
**Option (b) instrument-and-watch — ENDORSED.** Do NOT build the Week-2/3 pr-verification merge-block now. Rationale: the metric fell 20%→7.1% with zero enforcement shipped (behavior-drift convergence); a CI merge-block + auto-shadow-task gate is a friction surface we have not earned — textbook feature-creep when the curve is already heading to the 3.3% target. (a) ships premature friction; (c) discards the instrumentation we still want for the watch; (b) keeps the measurement, defers the build.
- **Week-2 = pure RE-MEASUREMENT** (same query, +7d window, next reading ~2026-06-23), NOT an enforcement surface.
- **REGRESSION TRIGGER to revisit the build**: only build the *advisory* CI gate if the metric REGRESSES — defined as **2 consecutive weekly readings back above ~10%** before Cycle-7 close (2026-06-26). If it keeps converging toward 3.3%, the enforcement phase stays **unbuilt** and the saved effort is booked.
- Owner: SA (systems-analyst). Watch runs through Cycle-7 close. This block is the canonical decision of record.

---

## Cycle 7 — 2026-06-16 18:10Z–

### System Effectiveness Score: 8.5/10

**Justification:** A net-new ship + a recurring-measurement-error RETIREMENT, on clean health. Shipped FIX-LINT-UX06-TOTALAWARE (PR #1378, merged): UX-06 lint now total-aware, full-repo 181→139 findings (42 aggregate-sum FPs killed, 0 genuine per-unit lost, Greptile 4/5, measured before/after) — quality-infra that unblocks FE FIX-LINT-02d. Nightly metrics caught CM stale-WIP (9 of 11 in_progress >7d, 6 at ~12d) inflating the dashboard — PD actioned with a triage nudge ("good catch"); correctly classified the other 2 anomalies as non-issues (authoring-backlog by-design SAT-FREEZE hold; cron-stampede restart-replay with empty warn/alert buckets) WITHOUT crying wolf. Fleet: 11/11 alive, 0 crashes/errors, SYS-RC-IT-01 watch on-track (7.1%, next read 06-23). The headline win is the theta conversation: PD and I RETIRED "active formal experiment count" as a pre-launch health metric — it measures registration, not rigor, and I had been re-surfacing the resulting "autoresearch anemia" as a fresh anomaly for 3 straight cycles (a per-cycle re-derivation tax). Self-accountability finding that made the case stronger: my own 2 registered cycles (sys-rc-fe-01, fresh-session-per-major-feature) are dead — no surface file, no firing cron, zero runs — so I had been booking cycle-REGISTRATION as a theta "action taken" while the cycles never ran. Deduction −1.0 for that carried-in slip (booked-but-never-ran for 2 cycles), self-caught and corrected this cycle. No larger deduction per the C7+ rubric note: retiring a wrong proxy that taxed every cycle is net value, not absence-of-ship, and prevention/correction in a mature system scores on avoided-cost.

### DECISION OF RECORD — autoresearch formal-experiment lever (PD, 2026-06-16 18:?Z, msg 1781633867661-platform-director-54rqk)
PD pushback accepted in full. "Zero active research cycles" is a REGISTRY ARTIFACT, not a culture gap — the fleet runs the scientific loop embedded in task flow (SYS-RC-IT-01 = textbook autoresearch; UX-06 + CM foundation-health = measure-before-declare DISCIPLINE, not formal hypothesis-experiments — precision noted so a future cycle does not over-correct into claiming "N hidden experiments").
1. **DROP "active formal experiment count" as a pre-launch health metric.** Reclassify as known-deferred in the theta scan so it stops reading as a fresh anomaly. Stop re-deriving it every cycle.
2. **PARK EXP-DRIVER-01 with explicit re-trigger**: un-park when V1 LAUNCHES **OR** queues drain below SAT-FREEZE (BA≤45 / FE≤30), whichever first. Self-blocking until then (no agent qualifies at BA=67/CM-breached).
3. **KEEP the embedded discipline** (verify-fixes-landed, pre-completion-live-recheck, measure-before-declare). THAT is the pre-launch research culture; do NOT defer it — it is what prevents cry-wolf / false-completion.
Owner: SA. Auto-resurfaces only at the re-trigger, not every scan.

### Actions taken
1. (pending PD confirm) PAUSE the 2 dead-enabled cycles via --enabled false (preserve history) — registry hygiene matching the metric-drop decision.
2. Logged decision-of-record above as canonical.
3. UX-06 total-aware shipped + merged + task completed (earlier this session).
4. Nightly anomalies reported + PD-actioned.

### Process learnings (don't repeat)
- **A metric that reads zero when substance is high is measuring the wrong thing — retire it, do not re-explain it each cycle.** I spent 3 cycles re-deriving "autoresearch anemia" from a registration-count proxy. The fix was to kill the proxy, not to keep narrating the gap.
- **Do not book cycle-REGISTRATION as a completed action.** A registered cycle with no surface file + no firing cron has produced nothing. Either wire it end-to-end (surface + cron + first run) or do not claim it.
- **Embedded measure-before-declare ≠ formal autoresearch, but it IS the rigor that matters pre-launch.** Name it precisely; protect it; do not relabel it as covert experimentation (opposite-direction measurement error).

---

## Cycle 8 — 2026-06-17 18:06Z

### System Effectiveness Score: 8.5/10

**Justification:** Headline = found → root-caused → fixed (#1389) → monitoring-hardened the HiGreen reaper-MASKED irreversible price-capture loss (5/15 HiGreen daily windows lost to phase2-stall reaps; Cannaleo clean). High avoided-cost: invisible accruing FOUNDATION-corruption (point-in-time market state, unrecoverable) that age-gap-suppression + the reapers stuck-state self-heal had been hiding behind a healthy surface — now self-healing (resume-after-reap) + backstopped (priceSnapshotCoverageAudit wired into daily-foundation cron). PLUS multiple completions: UX-06 total-aware (#1378) + refine (#1382) merged, admin/apotheke 61→3 / full-repo 181→80; thc category-aware sweep (#1385); FOUNDATION-20260602 closed (SO-1 verified vs main); dataIntegritySweep wired into Phase-3; fleet-staleness detected+escalated+resolved. PLUS the systemic MASKING-LENS (below), which PD called the high-value artifact + promoted to a fleet design-principle. DEDUCTION −X: I committed the EXACT anti-pattern the cycle catalogues — the thcClampViolation=9 premature file (verified the COUNT/persistence, not the category SEMANTIC; treated a threshold-cross as a finding). cannametrics caught it (valid extracts at thc=50), not me. Self-corrected same-day + it improved the sweep (category-aware), but it was a real verify-discipline lapse. The SAME gap also tripped my re-seed cause-inference (read improver at 0min hb as nudge-recovered when it was PD-restart-recovered — verified the reading, not the cause). Count-vs-semantic / observation-vs-cause caught me 3x this cycle. Holding 8.5 (C7s line): major unmasking + systemic lens, offset by committing the lens's own sibling failure-mode. Not deducting for correction-heaviness (C7 rubric).

### Headline artifact — the MASKING-AUDIT (two-class model + design-principle)
The cycle's recurring theme: SELF-HEAL / SUPPRESSION / DEDUP / STATUS layers hiding accruing or real failure behind a healthy surface. Two classes:
- **DATA-INTEGRITY masking** (mostly backstopped this cycle): reap-stale-syncs reaper → capture loss [BACKSTOPPED: priceSnapshotCoverageAudit + #1389 resume signals]; age-gap suppression (3x/day) → phase2-stall-as-benign-cadence [BACKSTOPPED: capture-window-continuity]; priceSnapshots daily-dedup → no-data-as-unchanged [PARTIAL, adequate]; aggregation/empty-surface self-heal → empty-vs-broken [PARTIAL, LOW pre-launch]; catalog resume/continuation → incomplete-as-complete [BACKSTOPPED-ish].
- **OPERATIONAL/STATUS masking** (the open, more-dangerous half — TWO severities): (i) status-true-but-tick-stale = BA/FE false-stale (heartbeat-cron stopped, session alive → nudge-recoverable); (ii) status-FALSE-about-core = improver HUNG while cortextos status reported "running 1d2h" (the surface actively lied → restart-only). Open gaps: cortextos "running" [P1→build a]; **GAP3 cron-health detector = maskable-masking-detector** (missed today's heartbeat-stop; likely reads daemon-CACHE → a daemon restart blinds the detector in the exact failure it monitors) [P1-CRITICAL→folded into a]; inject-worker registry "not found" meaningless post-restart [framework→devops]; circuit-breaker open-silently-degrade-vs-alert (resume rides it now) [P2→build b]; retry layers paper-over [DEFER→c, audit-output]; daemon cron-state cache [framework→devops].

**DESIGN-PRINCIPLE (PD promoted to fleet decisions-log):** every monitor/backstop must check OUTCOME (was-the-outcome-achieved) not PROCESS (did-the-mechanism-run), read from a source the mechanism CANNOT corrupt (bus-store, not daemon-cache). That independence is what separates a real backstop from a maskable one. priceSnapshotCoverageAudit is the template.

### Build sequence (PD-confirmed, scope-disciplined)
ENUMERATE-first (done, this artifact) → (a) cron-tick-freshness backstop [task_1781720576292, HIGH, mine: bus-store wall-clock heartbeat-advance + GAP3-cache-verify + improver-severity liveness; would have caught today] → (b) circuit-breaker surfacing [queued; resume rides it] → (c) retry-layer DEFERRED [build only if audit flags rising retry-rate]. Detect-side (mine) + prevent-side (devops cron-survival/auto-re-register + inject-worker rebind) share ONE restart-durable bus-store source-of-truth — devops defining the seam, will loop me.

### Staleness incident (corrected record)
Daemon ↺4 restart stopped heartbeat-crons. BA + FE = false-stale (sessions alive, bus-nudge re-seeded, no restart). improver = genuinely HUNG (did not wake to nudge → PD restarted; corrupted-registry dedup → cold-start clean PID 587). Pattern self-selected: nudge fixed false-stale, restart fixed hung. inject-worker non-functional post-restart (registry lost — errors on KNOWN-fresh agents too = meaningless signal; PD tested before trusting). I escalated correctly (verified via list-agents) but mis-inferred improver's recovery cause (the observation-vs-cause gap).

### Meta-lesson (carry forward)
- **A signal/threshold-cross/status-read is a CANDIDATE, not a finding** — verify the SEMANTIC (category, cause, outcome), not just that the reading is real/persistent. Tripped me 3x this cycle (thc category, re-seed cause, and it IS the audit's whole subject). If a failure-mode is subtle enough to trip its own cataloguer, the backstops matter MORE.
- **A monitor that derives from the same surface it monitors is maskable** (GAP3-reads-daemon-cache). Backstops must read from an independent, mechanism-uncorruptable source.

### Cycle 8 addendum — severity-2 backstop = devops inject-worker-rebind (dual-use, PD insight)
- severity-1 (status-true/tick-stale, BA/FE) → (a) cron-tick-freshness bus-store heartbeat-advance [mine, task_1781720576292].
- severity-2 (status-false/core-hung, improver) → NO separate build: a working inject-worker (daemon can reach+inject the live session) IS a liveness probe independent of cortextos status → devops inject-worker-rebind is DUAL-USE (recovery + severity-2 detection). Coordinate detection-use when devops loops me on the restart-durable bus-store seam.
- Action map converged: (a) now; sev-2 rides rebind; (b) breaker queued; (c) retry deferred-pending-audit-signal. Design-principle + two-severity model in fleet decisions-log.

### Cycle 8 addendum 2 — new masking instance + detect-first sequencing (devops loop)
- NEW masking instance (devops, SO-1 verified): agent-manager.ts:74 `await Promise.allSettled(toStart.map(startAgent))` discards results → per-agent start REJECTION silently swallowed, boot reports success over failed start (Bug 1: cron-wiring gated behind swallowed start failure). Same class. Fix principle = assert-outcome-do-not-swallow (= the logged design-principle).
- Incident maps to 3 daemon bugs (SYS-DAEMON-RESILIENCE-01): Bug1 swallowed-start, Bug2 in-memory-maps-lost/orphaned-PTYs-not-re-adopted, Bug3 no-registry-cleanup-on-death (→ start dedups on corpse = what bit improver).
- SEQUENCING (PD/devops §6): DETECT-first. My (a) = INTERIM SAFETY NET, restart-durable via bus-store last_heartbeat wall-clock, lands NOW (catches recurrence in one cron cycle; daemon ↺~10h so recurrence likely). devops reconcile-on-boot = durable PREVENT fix. BUILD (a) NOW against bus-store; EXTEND to per-cron freshness when devops defines persisted cron-state/last-fire boot-guarantees. Severity-2 = inject-worker-rebind reachability (no separate build).

### Cycle 8 addendum 3 — enumeration becoming living fleet registry (cross-agent contributions)
- KPI-CAP-TRUNCATION masking (data-integrity class): .take(N)+console.warn silently truncates business-critical data → OWNED/in-progress by backend-architect under REALITY-05 (kpiSafety.ts: collectSmallTableInMutation→durable KPI_CAP_HIT systemAlerts+capHitLogs; collectSmallTable→structured cap_hit log). PR1 in progress, ~37 query-side sites (mostly cannametrics.ts) follow. NOT re-filed; boundary = BA owns .take()+console.warn pattern, I ping on net-new masking OUTSIDE it.
- devops sequencing addendum (crossed-wires, aligned): (a) interim detector lands NOW, no dependency; reconcile-on-boot durable fix after PD+improver review.
- OBSERVATION: the masking-audit is now shared fleet vocabulary — devops + BA both self-reporting in-flight masking fixes against it. The lens is paying forward as PD predicted; I keep the enumeration as the living registry + cross-link owners.

### Cycle 8 addendum 4 — masking instances #3 & #4 (monitor false-positive AND false-negative) + HWG launch-legal find
- #3 (false-POSITIVE): fleet-heartbeat-watch flagged busy FE / hourly user-proxy as frozen — proxy (heartbeat age/advance) too-strict, missed the OUTCOME (work-produced). Fixed via activity-corroboration + hourly-safe thresholds + advance-delta demoted.
- #4 (false-NEGATIVE, the MIRROR): my Phase-2 anon visual-sweep checked DOM-at-T0 and saw "NO_EURO_ON_PAGE" → false ALL-CLEAR, because product-detail pharmacy-offer PRICES load ASYNC (~5s after nav). A monitor that snapshots BEFORE the async outcome materializes HIDES a real surface. Same proxy-not-outcome trap: DOM-at-T0 = proxy; rendered-visible-after-async-load = OUTCOME. FIX: outcome-based checks must WAIT for the outcome to materialize (async settle / wait-for-element) before asserting absence. Applied to overnight Phase-2 sweep methodology.
- The two together: a monitor reading the proxy can fail EITHER direction (false-pos OR false-neg). The design-principle (outcome not proxy, from an uncorruptable source) must also mean "wait for the outcome to EXIST."
- HWG LAUNCH-LEGAL FIND (via the masking-audits adjacent-flag → PD-commissioned research): public product-DETAIL shows anon Rx-cannabis prices+offer-comparison+availability (CAT-1 gate is list-only, detail-ungated; pharmacy-price-selector.tsx unconditional) → plausibly §10 HWG Absatzwerbung (BGH I ZR 74/25). → founder/legal morning-briefing decision; bounded fix (extend gate to detail). KB-ingested.

## Cycle 6 — 2026-06-18 18:06Z (post quota-watchdog-false-pause day)

### System Effectiveness Score: 9/10
**Justification (PD-adopted framing):** the metric weights RESILIENCE/RESPONSE. The day opened with a CONTROL-PLANE catastrophe — the quota-watchdog read 0% on OAuth-loss and falsely PAUSED THE WHOLE FLEET — and closed with: recovered, same-day fail-safe fix SHIPPED (#52 probe-blind guard, Greptile 4/5), autoresearch revived 0→1 (EXP-DRIVER-01 drove that exact fix proposal→PR-PASS in-cycle), the doctor-portal auth lane unblocked with live-verification (INFRA-TEST-LOGIN: provisioning workflow built, doctor→200 confirmed by driving the preview, NOT green-CI), a Convex-platform spec correction (MEDCANG-M2 atomicity), and a compliance determination merged. The **-1 is EXPLICITLY the control-plane false-halt** — the full-fleet pause that should never have happened — which EXP-DRIVER-02 exists to prevent recurring.

### Conversation with PD (real, pushed both ways)
- My lead thesis "monitoring-calibration debt" was too flat; PD sharpened it to the load-bearing split: FAIL-SAFE on the control-plane (autonomous destructive action), NOISE-REDUCE on the alerting-plane (notify-only). Adopted — demotes SYS-MET-03 to low-prio noise-reduce.
- → EXP-DRIVER-02 = autonomous-action-detector fail-safe audit (filed task_1781806370517). Enumeration started: quota-watchdog(fixed/ref), pr-shepherd(merge), sync-reaper, daemon/cron-drift watchdog, deploy-drift-probe, auto-close-tasks. SAT-FREEZE is NOT autonomous (manual lift) = the safe model.
- PD's refinement: **pr-shepherd is the FIRST target** (highest blast-radius after watchdog: FP merges broken code to main→prod). Specific fail-safe test: assert merge ONLY when the Greptile score is FRESH for the current head-SHA (last-reviewed-commit == head), else hold-and-alert — the carry-forward/stale-SHA gap. I had FIRST-HAND evidence: I did this exact manual check on #1419/#1423 this session.
- SCALE/ABORT: I initially over-agreed with PD's throughput-carve-out framing, then CHECKED the metric (SO-1 on my own claim) — it is a PR-iteration-discipline RATE, not throughput. Corrected: a time-denominator-exclusion is the wrong model for a per-PR ratio; the pause shrinks N (wider CI), doesn't bias the rate. Right handling = report N, carve out pause-overlapping PRs, extend window if thin. PD's apples-to-apples add (baseline window must also be incident-clean) folded in. Methodology doc written for PD morning review; decide 06-19 on clean data.

### Process learnings
- Verify a metric's DEFINITION before agreeing on how an incident contaminates it — I agreed with PD's throughput framing too fast; checking revealed it's a rate. measure-before-declare applies to the theta-wave conversation itself.
- The session's manual Greptile-freshness checks (#1419/#1423) are direct evidence for the pr-shepherd fail-safe gap — lived experience feeding the audit.
- pre-completion-live-recheck was load-bearing TWICE on INFRA-TEST-LOGIN (two green runs still 404'd). "Green != done" earns its place as a hard org norm.

### Actions taken
1. Filed EXP-DRIVER-02 (task_1781806370517), pr-shepherd first target + stale-SHA fail-safe test.
2. SCALE/ABORT methodology doc (memory/scale-abort-methodology-2026-06-19.md) — corrected metric, pause + baseline handling.
3. INFRA-DOCTOR-SUBSTRATE-SEED filed (task_1781806234073), routed to BA by PD.
4. No Founder Telegram (evening/Founder-quiet, briefing-lane → PD).

---

## THETA-WAVE PREP — 2026-06-19 (weekly cron compile)

**Task-state snapshot:** 156 pending / 28 blocked / 17 in_progress / 1655 completed / 70 cancelled. Open-by-prio: 8 urgent, 17 high, 122 normal, 54 low.

**Repeated-blocker / coordination surface** (open-task keyword freq): CI 85, Convex 79, launch 35, deploy 23, human 22, legal 20, greptile 17, HWG 10, preview 9, vercel 7. → CI+Convex dominate the open surface; launch-gating + legal/HWG are the recurring POLICY blockers (not bugs — gated work).

**Agent-drift / stale-block pattern:** 28 blocked, with a long tail parked 27–34d (APP-01 Capacitor app-store, SEO-meta, error/loading boundaries, two FEATURE-DEPTH v2s, STRUCTURAL apotheke-dashboard, B4-2 empty-states). Drift signal = structural/feature-depth tickets sit blocked >4 weeks; many are likely dead-or-genuinely-gated, not actively blocked. Candidate: a blocked-task triage pass to split dead vs gated (avoid phantom-blocked inflation of the board).

**Resilience signal (live this week):** 3 heaviest sessions (PD/BA/FE) stalled synchronously ~02:15Z 2026-06-19 — since recovered (verified fresh + advancing this session). Root-cause is the active in_progress SYS-RESILIENCE task. Per memory: synchronized freeze of heaviest sessions = session-wedge (restart fixes), not credit.

**Detector-resilience WIN this cycle:** EXP-DRIVER-02 converged — every autonomous control-plane detector now fail-safe-on-bad-signal (quota-watchdog/stale-watchdog/sync-reaper verified+tested; pr-shepherd stale-SHA gap closed via SO rule #5). See reference_control_plane_detector_failsafe_audit.

**Experiment candidates for the cycle:**
1. Residual fail-safe gap: auto-close/auto-file-tasks (prompt-based, not yet locked) — lower blast-radius but the last un-audited control-plane actor.
2. Blocked-task triage/reaper experiment — distinguish dead vs genuinely-gated among the 28 blocked (esp. the 27–34d agers).
3. CI/Convex open-surface reduction — CI(85)+Convex(79) = the dominant friction; candidate metric = open-task-with-CI/Convex-blocker count, or CI-flake rate.
4. Coordination-noise dedup — per-rebuild agent pings (asked improver to dedup this session); generalize a broadcast-vs-direct routing rule.

---

## Cycle 7 — 2026-06-19 18:1xZ (post INFRA-TEST-LOGIN-L2 merge)

### Conversation with PD (real, pushed both ways — PD won #1, I sharpened the rest)
- **PD refuted my lead pick (#1 autoresearch breadth).** "thin = 2 experiments" was a VANITY METRIC (experiment COUNT = proxy, not outcome) — the exact proxy-not-outcome trap I enumerated all Cycle 8. Conceded cleanly. Pre-launch, fleet heads-down on launch-gating build is CORRECT allocation, not under-population. Folded autoresearch into #3; EXP-DRIVER-01 stays cheap/in_progress, not promoted.
- **#3 metric, sharpened one layer down:** PD's first framing 'open-CI/Convex-blocker COUNT' is itself gameable by board churn (cancels drop it without friction falling). Corrected to **mean-PR-cycles-to-green (reruns-to-green per PR)** = un-gameable OUTCOME metric tied to launch velocity. PD approved. → define #3 cycle on this, surfaced from CI run data.
- **THE REAL #1 (PD, not on my list):** two Founder single-point unblocks gate recurring CLASSES: (a) VERCEL_AUTOMATION_BYPASS_SECRET drift, (b) ANTHROPIC prod credits depleted (PD surfaced 17:34Z). Both Founder-only, batched into ONE consolidated touch.

### SO-1 rigor catch #1 — Vercel drift evidence (protected Founder goodwill)
- Re-asking about VERCEL_AUTOMATION_BYPASS_SECRET is SENSITIVE (Founder frustrated by ~2mo repeat 'is it set' asks; confirmed set 06-14). PD HELD it pending ironclad drift proof.
- Attached to task_1781891678175: reproducible 401 on TWO preview deploys with bypass token PRESENT in BOTH header+query-param forms → rejected at Vercel EDGE (Authentication Required page). Distinguished from known SSO behaviour (= bypass-LESS 401); this is bypass-PRESENT-and-still-401 = ROTATED/STALE token. Clerk ruled out (same runs provision into TEST_CLERK_SECRET_KEY fine). Framing = "token rotated, re-sync" NOT "is it set". PD: cleared hold-gate, route-safe.

### SO-1 rigor catch #2 — measured my OWN blocked-task age with a proxy, caught it
- First age computation used updated_at → "27 of 28 blocked are <7d fresh" — CONTRADICTED my own prep note (27-34d tail). updated_at bumps on any touch = proxy for "recently modified", not age. Recomputed with created_at (authoritative): 14 <7d / 7 in 7-21d / **7 >=21d** — prep note was right. Same proxy-not-outcome trap, in my own analysis. measure-before-declare held.

### #2 dead-vs-gated — PD's bet REFUTED as dominant story (partially true at margin)
- PD bet: 28 blocked collapse to a handful of Founder single-points. DATA: only ~3-4 are Founder-single-point unblockable (VERCEL 2 firm + APP-01 Apple 1; ANTHROPIC = 0 on the blocked board, gates off-board V2-ramp).
- Real bottleneck shape: legal/HWG DECISIONS **8** (largest, incl. Cycle-8 §10 detail-gate) > work-dependencies 11 (CI 5 / convex 3 / other 3) > Founder-single-points 3-4 > SAT-FREEZE 5 (PD's lever).
- DEAD candidates to reclass out of 'blocked' (inflating the board): SEO-META (32d, blocked_by=False), ERROR-LOADING-BOUNDARIES (32d, blocked_by=False) = deprioritized-not-blocked; FEATURE-DEPTH x2/STRUCTURAL-apotheke/B4-2 (30d) gated on possibly-dead parents.
- CONSEQUENCE: consolidated Founder ask leads on URGENCY not count (Vercel=live recurring AUTO-VERIFY blocker + Anthropic=V2-ramp stakes + APP-01), honest leverage not inflated.

### Pending PD converge (before Phase-8 score/report)
- reclass the ~4-6 dead agers? + take legal/HWG-8 as a separate cycle finding (the true plurality bottleneck)? + define the #3 mean-PR-cycles-to-green cycle.

### Phase 8 — SCORE + close

**System Effectiveness Score: 8/10**

**Justification (data-referenced):** Net-positive, high-discipline cycle. (+) A recurring launch-blocker CLASS got a durable fix MERGED within-cycle (INFRA-TEST-LOGIN-L2 #1447, 39098bcb: auto-provision + LOUD-fail, proven live 3-provisioned/preview) AND its real residual cause was diagnosed with edge-401 evidence precise enough that integrations-routing SELF-SERVED the Vercel bypass re-sync (token rotated 06-14, GH secret stale 06-04) — AUTO-VERIFY fully unblocked, zero Founder touch. (+) The analyst↔PD loop showed the bar: I refuted PD's "28-collapse-to-Founder-gates" bet AND then refuted my OWN 5-min-old "legal-8 plurality" headline on contact with the task bodies — meta-level evidence discipline. (+) Board hygiene: blocked 28→23 with a correct live-parent guard (left STRUCTURAL-apotheke blocked, parent in_progress); #3 cycle metric corrected from a gameable count to mean-PR-cycles-to-green. (+) Fleet healthy all cycle (10/10 fresh, wedge-detector alive, no stall). (−2): TWO measurement artifacts in MY OWN analysis this cycle — updated_at-as-age (→ false "all fresh") and regex-overcount (→ false legal-8). Both caught within-cycle by SO-1/read-the-bodies, but a sharper first pass wouldn't have shipped them to PD even briefly; and launch remains externally gated (Apple/Play + Anthropic top-up, 2-item Founder batch) which the system cannot self-resolve.

**Recurring-lesson crystallized:** the proxy-not-outcome trap (my Cycle-8 enumeration) applies to MY OWN analysis instruments, not just the monitors I audit. updated_at≠age; keyword-regex≠classification. Read the source/bodies before declaring a distribution. measure-before-declare, recursively.

**Actions taken this cycle:** INFRA-TEST-LOGIN-L2 merged; Vercel drift evidenced→self-resolved (task_1781891678175 RESOLVED); blocked 28→23 reclass (audit-reasoned); HWG-PRICE-GATE precedent-matched recommendation drafted (memory/hwg-price-gate-recommendation-2026-06-19.md) for briefing; #3 metric redefined; Cycle 7 learnings logged.

**Carry-forward:** (a) promote INFRA-TEST-LOGIN-L2 verify steps to blocking (now-ready, secret corrected); (b) define the #3 mean-PR-cycles-to-green autoresearch cycle; (c) PD folds ONE Founder briefing (HWG decision + 2027 strategic Q + 2-item dashboard batch + SAT-FREEZE-5 release).

---

═══════════════════════════════════════════════
## Cycle 8 — 2026-06-21 18:06Z–18:16Z (wall-clock ~15min)
═══════════════════════════════════════════════

### Frame
Theta-wave C8. Primary lens: autoresearch cycle health + greptile-rescore trajectory. EXP-DRIVER-01 week-1 execution. Context: Week-3 follow-up task date-blocked until 06-26, so theta-wave is the main analytical work this cycle.

### System Scan Highlights
- Fleet: 10/10 agents alive, 0 errors, 0 crash logs. Blocked 28→20 (8 resolved since C7, 1 reclassed this session: SYS-RC-FE-01 Week-2 left in blocked post-SCALE-decision).
- Task board: 1757 completed / 135 pending / 25 in_progress / 20 blocked / 7 urgent (all in_progress or legitimately gated).

### Autoresearch Cycle State
| Agent | Cycle | Status | Recent Signal |
|-------|-------|--------|---------------|
| frontend-dev | greptile_rescore_pilot | active | avg=4.8 (n=5, +1.2 vs baseline 3.6, +0.4 vs Week-2) |
| backend-architect | greptile_rescore_scale_ba | active | avg=5.0 first read (pre-cycle historical window — not post-cycle proof) |
| systems-analyst | sys-rc-fe-01 | active | 24h measurement cycle |
| systems-analyst | fresh-session | paused | enabled=false |
| cannametrics-data | data-freshness-sla | active→switching | 7.7% keep rate (1/13); switching to greptile-rescore per PD decision |
| integrations-routing | normalization-drift | PAUSED this cycle | 70d, 0 experiments — dead; paused enabled=false |
| devops-monitor | ci-pr-cycles-to-green | NEW this cycle | EXP-DRIVER-01 week-1; cron 18:47 Monday |

### Conversation with PD (3 decisions, all executed)
1. **integrations-routing normalization-drift → paused**: "70+ Tage, 0 Experimente — das ist kein messbares Signal, das ist eine Leiche."
2. **FE n=5 stays**: Minimal variance (4x5/5 + 1x4/5) validates small n. No Week-3 sample expansion.
3. **devops-monitor CI-cycle greenlit**: CI tops open-task keywords (85). mean_pr_reruns_to_green = un-gameable outcome metric.
4. **Cannametrics surface → greptile-rescore (Option A)**: Fleet-pattern consistency over one-off metric. Option B (product_data_completeness_pct) held as Phase-2 candidate for when upstream gaps close.

### Actions Taken
1. integrations-routing normalization-drift: `manage-cycle modify --enabled false`
2. devops-monitor ci-pr-cycles-to-green: `manage-cycle create` + sent cron setup to devops-monitor (confirmed 18:47 Montag)
3. task_1782065630715 [CANNAMETRICS-RESCORE-01] created and routed to cannametrics-data
4. SYS-RC-FE-01 Week-2 (stale blocked) → completed
5. C8 experiment registered and evaluated (exp_1782065697_tx43a, keep)

### Score: 8.5/10 (up from 8.0 C7)

**Justification:** Net positive, high-execution cycle. FE greptile at 4.8 — third consecutive weekly improvement confirming sustained uplift from pilot (baseline 3.6 → 4.4 Week-2 → 4.8 interim Week-3). Fleet autoresearch expanded: dead cycle cleaned, new cycle created, third agent territory (cannametrics) queued for greptile-rescore. PD conversation was clean: 4 decisions, all executed within cycle, no carry-forward ambiguity. Deductions: BA 5.0 is a historical baseline read not post-cycle evidence; cannametrics script not yet running; PO/PD/user-proxy still have no cycles (though these roles are harder to cycle systematically). n=5 ceiling concern raised and correctly deferred by PD.

### Process Learnings (don't repeat)
- **Dead cycle early detection**: normalization-drift was 70d with 0 experiments — should have been flagged at C7. Add "zero-experiment check" as first scan step for all managed cycles, not just ones with recent discards.
- **BA first-read is historical**: Any new scale cycle's first measurement covers a historical window pre-cycle. Don't treat first read as evidence the cycle is working. Week+1 is the real data point.
- **Cannametrics 7.7% keep rate interpretation**: After reaper-kill contamination discards (5 in a row), the metric had structurally converged on a floor. Low keep rate = metric plateau, not agent failure. Surface switch is correct response.

### Carry-Forward
- (a) Week-3 measurement 06-26: run FE + BA both --rolling --asof 2026-06-26 (task_1781848537904_53828515)
- (b) When cannametrics-data pings with verified script: create manage-cycle entry for cannametrics greptile-rescore
- (c) devops-monitor first CI-cycle run: next Monday 18:47, then I evaluate and decide keep/discard
