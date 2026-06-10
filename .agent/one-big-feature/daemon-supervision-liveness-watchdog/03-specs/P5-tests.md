# P5 — Tests (env-clean)

**Targets:** `tests/unit/daemon/`, `tests/unit/cli/`, `tests/unit/bus/` (match existing layout).
**Run discipline:** scrub all `CTX_*` env vars before running (`feedback_cortextos_test_env_clean_first`) — `CTX_AGENT_DIR`/`CTX_PROJECT_ROOT` leak phantom failures.

## Required tests
1. **P1 marker write path** — Stop-hook/cron-fire advances `loop-progress.json`; `logEvent` and the 50-min timer do NOT. `getLastProgressAt()` returns 0 on missing file without throwing.
2. **P2 stall fires** — marker+stdout+outbound+cron frozen ≥ threshold AND pending work → one `loop_stall` restart.
3. **P2 idle safety (MUST-HAVE regression)** — same freeze but empty inbox + no due cron → NO restart.
3b. **P2 long-live-turn safety (MUST-HAVE regression)** — pending inbox + Stop flag stale ~12 min BUT tool-activity timestamp advancing → NO restart. This is the test that actually guards the codex/subagent restart-storm vector (the most dangerous failure mode).
3c. **stdout excluded** — stdout growing but Stop flag + outbound + tool-activity all frozen + pending work → still detected as stall (proves stdout is not a progress signal).
4. **P2 circuit breaker** — repeated stalls open the breaker, single page, no loop.
5. **P3 stale-context routing** — stale context_status + pending work → stall path; fresh context_status → tiering unchanged (snapshot the existing warn/handoff/Tier-3 behavior to prove no regression).
6. **P4-A registry** — failed start releases lock; registered-but-dead agent restarts without disable/enable; concurrent live starts still dedupe.
7. **P4-B instance resolution** — restart/stop/start resolve `CTX_INSTANCE_ID` when flag absent; explicit flag wins; neither → default.
8. **SF-4 instance-path consistency** — the progress accessor reads `last_idle.flag` from the SAME instance-resolved dir `hook-idle-flag.ts:16` writes to (mismatch = permanent false-stall).
9. **Kill-switch** — `stall_watchdog_enabled=false` → P2 detector fully inert (no restarts regardless of stall state).

## Gate
- `npm run build` clean (tsc strict, no `any`).
- Full `npm test` green env-clean.
- No `console.log` left in committed source (daemon uses the existing `this.log`/`log` channels).
