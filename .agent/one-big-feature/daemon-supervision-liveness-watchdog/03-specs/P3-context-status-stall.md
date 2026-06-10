# P3 — context_status early-returns no longer gate liveness

**Targets:** `src/daemon/fast-checker.ts` — `checkContextStatus()` early returns at **966** (`if (!existsSync(statusPath)) return;`) and **974** (`if (age > 10*60_000) return; // stale`); and `pollCycle()` ordering.
**Depends on:** P2.
**Goal:** Remove the kill shot — stale/absent `context_status.json` must not silently disable liveness detection.

## Architect correction (SF-1 — applied)
Do NOT call the stall path from inside `checkContextStatus()` — that recreates the B3 coupling. Instead:
- **P2's stall check runs unconditionally in `pollCycle()`, independent of `checkContextStatus()`.** Confirm the call site of `checkContextStatus()` in `pollCycle` and ensure the P2 stall evaluation runs regardless of whether `checkContextStatus()` returned early.
- `checkContextStatus()` keeps both early returns (966 + 974) for its OWN purpose (context tiering only). They no longer gate liveness because liveness is decided elsewhere (P2). Both the file-absent (966) and stale (974) paths are covered because P2 doesn't read `context_status.json` at all.

## Key invariant
The "is this loop wedged" decision must not depend on `context_status.json` freshness — that file freezes exactly when the loop wedges. P2's signals (Stop flag + outbound + tool-activity + cron) are the sole authority.

## Acceptance
- Frozen `context_status.json` (>10 min) OR absent file + pending work → P2 stall path still engages (liveness not suppressed).
- Fresh `context_status.json` → existing warn/handoff/Tier-3 tiering byte-for-byte unchanged (snapshot test).
- Idle agent + stale/absent context + no pending work → no restart.
