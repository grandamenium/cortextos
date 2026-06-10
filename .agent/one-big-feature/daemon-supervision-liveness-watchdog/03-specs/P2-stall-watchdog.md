# P2 — Stall watchdog in FastChecker

**Targets:** `src/daemon/fast-checker.ts` (`pollCycle()` — make this the SOLE owner of the liveness/stall decision, independent of `checkContextStatus()`), plus a mid-turn tool-activity signal.
**Depends on:** P1.
**Goal:** Detect "loop wedged" and hard-restart with reason `loop_stall` — WITHOUT killing healthy agents on long turns.

## Architect correction (BLOCKER 2 — applied). Read this first.
The naive "no Stop for N min" detector cannot distinguish a wedged loop from a legitimately long single turn (codex handoff, subagent, long WebFetch) — both leave `last_idle.flag` stale. And **`stdoutLogSize` is NOT a valid progress signal**: per `fast-checker.ts:1243-1246`, Claude Code writes ANSI spinner bytes to stdout constantly even when idle, so stdout grows whether the loop is alive or wedged. Using stdout would cause false negatives (wedge looks alive) or, if discounted, leave long turns unprotected. **Exclude stdout from progress.**

## Progress definition (authoritative)
"Made progress since last check" = ANY of:
- `getLastProgressAt()` advanced (P1: Stop flag or cron-fire), OR
- `outboundLogSize` grew (agent sent a message — real activity), OR
- **mid-turn tool-activity timestamp advanced** (NEW — see below).
**Explicitly EXCLUDE `stdoutLogSize`.**

## Mid-turn tool-activity signal (NEW — the long-turn distinguisher)
A turn that is *working* fires tool calls; a *wedged* loop fires nothing. There is already a `PreToolUse` hook wired (`hook-loop-detector`) and a `PostToolUse` event. Piggyback a timestamp write (`state/<agent>/last_tool_activity` or fold into the progress accessor) on an existing PreToolUse/PostToolUse hook so a long-but-live turn keeps advancing progress between Stop events. This is what separates "busy on one slow turn" from "wedged." If piggybacking on the existing hook is not clean, add a minimal hook — but it MUST be fleet-wired and instance-resolved (SF-4).

## Stall rule
Track `lastProgressObservedAt`. If no progress for `STALL_THRESHOLD_MS` AND pending work exists → `forceRestart(reason="loop_stall")`.
- **Default `STALL_THRESHOLD_MS` = 20 min** (longer than Frank2's wedge-detection benefit still beats 90 min, but above known-legitimate codex/subagent turn lengths). Per-agent config-overridable.
- Pending work = inbox has unread OR a cron fired-but-unprocessed (fired ts newer than last progress). A quiet idle agent (empty inbox, no due cron) is NEVER stalled.

## Kill-switch (NTH-3 — required given fleet blast radius)
Add per-agent config `stall_watchdog_enabled` (default **false**). Enable on Frank2 first (master-plan rollout), then fleet-wide once validated. A misfiring detector must be disable-able via config without a redeploy.

## Circuit breaker
Reuse `ctxCircuitBrokenAt` / `ctxCircuitRestarts` pattern (`fast-checker.ts:952-962`): if `loop_stall` restarts exceed N in a window, open breaker, single Telegram page to Josh, stop auto-restart until reset. Note: the breaker bounds storm amplitude, NOT the first wrong kill — getting the detector right (above) is the real protection.

## Acceptance
- Wedged: Stop flag + outbound + tool-activity all frozen ≥ threshold AND pending work → exactly one `loop_stall` restart.
- **Long live turn (MUST): pending inbox + Stop flag stale 12 min but tool-activity advancing → NO restart.** (The storm guard.)
- Quiet idle: frozen + empty inbox + no due cron → NO restart.
- stdout growing but everything else frozen + pending work → still detected as stall (proves stdout excluded).
- Breaker opens on repeated stalls; one page; no loop.
- `stall_watchdog_enabled=false` → detector inert.
