# Master Plan — Daemon Supervision: Liveness Watchdog + Instance Resolution

**Slug:** `daemon-supervision-liveness-watchdog` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos`
**Status:** SPEC_PASS (architect-reviewed, 2 BLOCKERs + 4 SHOULD-FIX folded in 2026-06-10) — awaiting Josh SCOPE_VALIDATION before codexer dispatch.

## Architect review outcomes (applied to shards)
- **BLOCKER 1:** P1 reuses the existing fleet-wired Stop hook `hook-idle-flag.ts` → `last_idle.flag` (already read by FastChecker `isAgentActive()` 1276). No new `loop-progress.json`, no new fleet hook wiring.
- **BLOCKER 2:** P2 excludes `stdoutLogSize` (spinner bytes grow even when idle, `fast-checker.ts:1243-1246`) and adds a mid-turn tool-activity signal so long legitimate turns (codex/subagent) are not killed; default threshold raised to 20 min; per-agent `stall_watchdog_enabled` kill-switch (default off, Frank2 first).
- **SF-1:** P2 owns the stall decision in `pollCycle()`; P3 just stops `checkContextStatus()` early-returns (966 + 974) from gating liveness — no stall-call from inside the context monitor.
- **SF-2:** P4 registry reconcile keys on PID liveness ONLY (not marker staleness → avoids double-spawn vs BUG-011).
- **SF-4:** P1 marker read/write must share the same instance-resolved state dir.
**Source of truth:** `01-spec.md` (5 confirmed root causes B1–B5, all verified against current source 2026-06-10).

## Goal
Make the daemon detect a wedged-but-not-crashed agent loop within minutes (not 90), by decoupling liveness from the side-effect heartbeat, adding a real stall watchdog, fixing the context-monitor self-disable, releasing the stale registry lock automatically, and making the agent-side CLI honor `CTX_INSTANCE_ID`.

## Why one-big-feature (not M2C1)
Single cohesive feature, single repo (`cortextos`), no schema migration, no new repo, no cross-repo coupling. All changes live under `src/daemon/`, `src/bus/`, `src/cli/`, `src/hooks/`. The CLI instance fix (B5) is folded in because it touches the same daemon CLI surface and the same incident's recovery path. **Not** M2C1-scale — no migration/new-repo/multi-repo trigger.

## Fleet-wide blast radius (flag for SCOPE_VALIDATION)
This changes supervision behavior for **every** agent, not just Frank2. The dominant risk is a **restart storm**: a too-aggressive stall detector could hard-restart healthy-but-idle agents. The plan mitigates with: pending-work gating (only restart if inbox/cron work is actually waiting), a conservative default N (~15 min), multi-signal progress detection (marker + stdout + outbound + cron-fire), and reuse of the existing context-restart circuit breaker pattern (`ctxCircuitBrokenAt`).

## Phases
- **P1 — Liveness marker (foundation, gates P2/P3).** New progress-marker state file written only on real loop progress (Stop hook + cron-fire). Stop B1's heartbeat side-effects from reading as liveness. Spec: `03-specs/P1-liveness-marker.md`.
- **P2 — Stall watchdog in FastChecker.** Multi-signal no-progress detector, pending-work gated, circuit-breaker protected, reason `loop_stall`. Spec: `03-specs/P2-stall-watchdog.md`.
- **P3 — Context-status stale = stall, not skip.** Reroute `fast-checker.ts:974` early-return into the P2 stall path when stale + pending work. Spec: `03-specs/P3-context-status-stall.md`.
- **P4 — Registry-lock hygiene + CLI instance resolution.** try/finally release + liveness reconcile in `agent-manager.ts`; mirror `status.ts:12` resolution into `restart/stop/start` + audit siblings. Spec: `03-specs/P4-registry-and-instance.md`.
- **P5 — Tests (env-clean).** Unit + regression per `01-spec.md` test plan; the must-have is the "quiet healthy idle agent is NOT restarted" regression. Spec: `03-specs/P5-tests.md`.

## Critical path
P1 → (P2, P3) → P4 is independent and can land in parallel with P1-3. P5 gates the PR.

## Acceptance
See `01-spec.md` §Acceptance criteria (7 items) + §Test plan. PR-blocking: `npm run build` clean, full `npm test` green env-clean.

## Risks
- **Restart storm (highest)** — mitigated by pending-work gating + conservative N + circuit breaker + the explicit "idle healthy agent not restarted" regression test.
- **Marker write reliability** — if the Stop hook fails to write the marker, a healthy agent could look stalled; mitigated by multi-signal (stdout/outbound/cron also count as progress, so marker is not the sole signal).
- **Frank2 as live test case** — Frank2 volunteered; validate the marker hook on Frank2 first before fleet-wide.
- **Recovery runbook stays valid** until P4 ships: `disable <agent> --instance cortextos1` then `enable`.

## Process gate
Codexer dispatch will carry: `GATE: build framework=one-big-feature slug=daemon-supervision-liveness-watchdog repo=/Users/joshweiss/code/cortextos`. Diff returns to Larry for adversarial build-review (scope match vs the 5 root causes, no `any`/`console.log`, env-clean tests present, restart-storm regression verified) before any PR. Josh approves the PR before merge.
