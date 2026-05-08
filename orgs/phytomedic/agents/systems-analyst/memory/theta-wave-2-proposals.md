# Theta Wave Cycle 2 — Overnight Proposals (for platform-director 10:03 cascade)

## 1. Experiment Design: backend-architect — Greptile Score Per PR

**Cycle name:** greptile-quality-score
**Agent:** backend-architect
**Metric:** greptile_score_per_pr (quantitative, 0–5)
**Direction:** higher
**Surface:** PR Greptile review output (Greptile score integer per PR, captured from deployment guard reports or direct Greptile API)
**Measurement window:** 5 PRs rolling
**Measurement method:** After each PR deployment guard run, record the Greptile score (1-5). Track rolling average over last 5 PRs. Experiment = one change to coding approach or review practice (e.g. self-review against Greptile checklist before pushing). Evaluate: did rolling average increase?
**Loop interval:** per-PR (triggered by deployment guard, not a fixed cron)
**Hypothesis:** if backend-architect explicitly checks against common Greptile P1 patterns before pushing (N+1 queries, unvalidated params, any() fields), Greptile scores will trend toward 4.5/5 average.
**Why now:** PR #294 had 2 P1 findings. Multiple PRs this week have had Greptile feedback cycles. Formalizing this as a measured experiment will create systematic improvement.

## 2. Experiment Design: frontend-dev — Bug Escape Rate

**Cycle name:** bug-escape-rate
**Agent:** frontend-dev
**Metric:** bug_escape_rate (quantitative, %)
**Direction:** lower
**Surface:** systems-analyst sweep reports (bugs found post-merge vs total bugs found in session)
**Measurement window:** 3 sweep batches rolling
**Measurement method:** After each sweep batch, count: (A) bugs found that were introduced by a frontend-dev PR already merged to main, (B) bugs caught pre-merge by systems-analyst during PR review or same-session fixes. Escape rate = A / (A + B) × 100. Experiment = one change to frontend-dev pre-push checklist (e.g. explicit auth surface check, data integrity check for undefined/NaN).
**Loop interval:** after each sweep batch (~every 6h on active days)
**Hypothesis:** if frontend-dev adds a 5-point self-check before pushing (auth gate, undefined/NaN, mobile layout, empty states, GDPR surface), bug escape rate will drop below 20%.
**Current baseline:** This session: 2 security bugs (auth bypass) escaped to prod — both introduced before the sweep system was mature. Baseline: ~2-3 bugs per sweep batch found post-merge.
**Why now:** 7 sweep batches in, we now have enough data to measure escape rate meaningfully.

## 3. Goals.json Refresh Draft (systems-analyst goals)

**Current (2026-04-18, stale):**
1. Track test coverage expansion (incomplete — no recent data)
2. Verify insertRoutingEvent (DONE — 8 call sites confirmed)
3. Architecture drift check (DONE — LOW risk, reviewed 2026-04-28)
4. V2 readiness scorecard (DONE — completed 2026-04-24)

**Proposed refresh:**
Focus: security coverage, experiment oversight, coherence audit completion, Cannametrics integrity

1. Complete cross-page coherence audit — Clusters 3 (Doctor↔Condition↔Prescription↔Checkout) and beyond. File bugs, track fixes.
2. Auth surface coverage — after every sweep batch, verify new routes added since last check have middleware protection. File checklist into sweep skill.
3. Experiment oversight — ensure all 6 agents have at least 1 active autoresearch cycle by end of May. Track keep rates and surface converged cycles for modification.
4. Cannametrics data integrity — weekly check: imageUrl backfill status, priceSnapshot gap (Apr 15-28), offer freshness p95, routingEvent completeness. Report to platform-director.

## 4. Auth Surface Coverage Check — Sweep Batch Addition

**Proposal:** Add Phase 0 to every sweep batch run:
1. Run `git log --since="last-sweep-date" --name-only --diff-filter=A -- "*/app/**/*.tsx" "*/app/**/*.ts"` to find new files added to app router since last sweep
2. For each new page route file, verify it appears in proxy.ts/middleware.ts matcher OR that it is an explicitly intentionally public route
3. File HIGH task immediately if any new route is unprotected and not explicitly public

**Implementation:** Modify `.claude/skills/step-by-step-sweep/SKILL.md` to include this phase 0 check. Low effort, high security value.
**Evidence:** /onboarding/arzt and /onboarding/apotheke were added after the initial middleware review. A git-based check would have caught these on the next sweep run.
