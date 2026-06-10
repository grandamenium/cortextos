# Spec — Daemon Supervision: Liveness Watchdog + Instance Resolution

**Slug:** `daemon-supervision-liveness-watchdog` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos`
**Author:** Larry · **Date:** 2026-06-10 · **Source RCA:** `orgs/clearworksai/agents/larry/memory/2026-06-10-frank2-stall-rca.md`

## Josh's Exact Request
> "Diagnose and fix for the future why could that happen" (Frank2 went dark ~90 min, no morning brief, while monitoring showed `running=true` + fresh heartbeat).
> Then on the fix approach: **"go with your recs."** — recs = do the Frank2 supervision fix FIRST (fleet-wide blast radius), fold the CLI instance bug into it (same daemon files).

## Problem
Frank2's Claude main loop wedged mid-turn ~14:00Z inside a long-lived (27h, summarized, 0 restarts) session. The daemon kept reporting healthy for ~90 min because **the heartbeat does not mean the loop is alive**, and the one force-restart path that could have rescued it **self-disables exactly when the loop wedges**. Recovery required `disable`+`enable` because a stale in-memory registry lock made plain `restart`/`start` dedupe. Separately, the agent-side CLI (`restart`/`stop`/`start`) ignores `CTX_INSTANCE_ID`, so those commands hit the dead `default` instance unless `--instance cortextos1` is passed by hand.

This is a **framework supervision** class bug — it affects every agent in the fleet, not just Frank2.

## Confirmed root causes (verified against current source 2026-06-10)

### B1 — Heartbeat ≠ liveness (false-healthy)
`last_heartbeat` is bumped by activity that is NOT loop-progress:
- `src/bus/event.ts:67-87` — `refreshHeartbeatTimestamp()` runs on **every** `logEvent()` as a side-effect; any `cortextos bus log-event` refreshes the heartbeat.
- `src/daemon/fast-checker.ts:112-120` — an idle-session watchdog `setInterval` fires `bus update-heartbeat "[watchdog] … idle session"` every **50 min regardless of REPL state**.
So a green heartbeat means "some bus call or the 50-min timer ran," not "the main loop processed a turn." `list-agents`/dashboards trust it → false healthy.

### B2 — No stall/hang watchdog
FastChecker's only auto-restart triggers are: context-% thresholds (`checkContextStatus()`), hard API-overflow strings in PTY output (`fast-checker.ts:995-998`), and PTY process exit/crash. There is **no** detector for "loop alive but not progressing" (no cron fired / no turn completed / stdout not growing for N min while inbox or cron work is pending). A wedged-but-not-crashed, not-context-full loop is invisible.

### B3 — Context monitor self-disables exactly when needed (the kill shot)
`src/daemon/fast-checker.ts:949-1015 checkContextStatus()`:
```ts
const age = now - new Date(data.written_at || 0).getTime();
if (age > 10 * 60_000) return; // stale file — skip   (line 974)
```
`context_status.json` is written by the in-process hook `src/hooks/hook-context-status.ts`, which only fires after a Claude turn / statusline update. When the loop wedges the hook stops → the file goes stale → line 974 returns early. The Tier-3 force-restart (line 1010, "handoff not completed within 5min") sits **below** that early return, so it can never fire on a wedged loop. The one mechanism that could rescue a stuck agent is gated behind a freshness signal that only exists while the agent is healthy.

### B4 — Stale in-memory registry lock blocks restart
`src/daemon/agent-manager.ts:231-242 inspectAgentOp()` returns `DEDUPED` for a `start` purely on `this.agents.has(name)` — no reconcile against real process liveness. A failed/aborted in-flight start leaves the agent registered, so subsequent `start`/`restart` dedupe forever ("already in registry") even though the PTY is dead. Only `disable` (deregister) + `enable` (re-register) clears it.

### B5 — CLI ignores `CTX_INSTANCE_ID` (the fold-in)
`status.ts:12` resolves correctly: `const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';` (option has no hard default — line 9).
But `restart.ts:7`, `stop.ts:24`, `start.ts:31` all declare `.option('--instance <id>', 'Instance ID', 'default')` and pass `options.instance` straight into `new IPCClient(...)`. The hardcoded `'default'` shadows `CTX_INSTANCE_ID`, so agent-side `restart/stop/start` hit the dead default instance. This is why `status` worked from an agent shell but `restart` didn't.

## Fix design (durable)
- **B1/B2/B3 (A) — Real liveness marker.** Introduce a progress marker written ONLY on actual loop progress (Stop hook fire and/or cron-fire), e.g. `last_turn_completed_at` in a dedicated state file (NOT heartbeat.json). Supervision and `list-agents` health read THAT. The 50-min idle bump and event side-effect bump stay for "process responsive" telemetry but must not be readable as loop-liveness.
- **B2 (B) — Stall watchdog in FastChecker**, independent of `context_status.json`: if no loop progress for N min (default ≈15) AND pending inbox/cron work exists, hard-restart with reason `loop_stall`. Progress signals: the new liveness marker + stdout-log growth + outbound-message-log growth + cron-fire (FastChecker already tracks `stdoutLogSize`/`outboundLogSize`).
- **B3 (C) — Stale `context_status.json` is a stall signal, not a skip.** At `fast-checker.ts:974`, when the file is stale >10 min AND there is pending work / no progress, route into the stall path (B) instead of `return`.
- **B4 (D) — Registry lock hygiene.** Wrap the in-flight start in `try/finally` that always releases the registry entry on failure; make `start`/`restart` reconcile against actual liveness (pid alive + marker freshness) so a dead-but-registered agent restarts without `disable`/`enable`.
- **B5 (E) — Instance resolution.** Mirror `status.ts:12` into `restart.ts`, `stop.ts`, `start.ts` (drop the `'default'` option default; resolve `options.instance || process.env.CTX_INSTANCE_ID || 'default'`). Audit `stop --all`, `enable`, `disable`, `notify-agent`, `doctor` for the same pattern; fix any that hardcode.

## Out of scope
- Rewriting the context-handoff tiering logic (B1–B3 only touch the liveness signal + stall path, not the warn/handoff thresholds).
- Changing heartbeat semantics for external dashboards beyond adding the new marker (briefs dashboard read-side is a separate task).
- The brief-as-dashboard-tab fix and Wiki OBF (separate slugs, queued after).

## Acceptance criteria
1. A loop that stops processing turns (no Stop-hook fire / no cron fire) for > N min while inbox or cron work is pending → FastChecker hard-restarts with reason `loop_stall`, within ~N min (not 90).
2. `list-agents`/status health reflects loop-progress liveness, not the side-effect heartbeat: an agent with fresh heartbeat but frozen progress marker reads as **unhealthy/stalled**.
3. A stale `context_status.json` (>10 min) with pending work no longer silently skips — it escalates to the stall path.
4. After a failed in-flight start, a subsequent plain `cortextos restart <agent>` (or `start`) succeeds without `disable`/`enable` — the registry lock is released and liveness-reconciled.
5. From an agent shell with `CTX_INSTANCE_ID=cortextos1` set, `cortextos restart <agent>` / `stop` / `start` (no `--instance` flag) target `cortextos1`, not `default`.
6. The 50-min idle heartbeat bump and `logEvent` heartbeat refresh no longer cause a wedged loop to read as healthy.
7. `npm run build` clean (tsc strict); full `npm test` green, run env-clean (scrub `CTX_*` first per `feedback_cortextos_test_env_clean_first`).

## Test plan (env-clean)
- Unit: liveness marker written on Stop-hook/cron-fire path; NOT written by logEvent or 50-min timer.
- Unit: stall detector fires when marker+stdout+outbound all frozen N min AND pending work; does NOT fire when idle with no pending work (no false restart of a quiet agent).
- Unit: stale context_status + pending work → stall path; fresh context_status → normal tiering unchanged.
- Unit: `inspectAgentOp('start')` on a registered-but-dead agent → allows restart (liveness reconcile), not DEDUPED; try/finally releases lock on simulated start failure.
- Unit: instance resolution — `restart/stop/start` resolve `CTX_INSTANCE_ID` when `--instance` absent; explicit `--instance` still wins; absent both → `default`.
- Regression: a quiet, healthy, idle agent is NOT restarted by the stall watchdog (the dangerous failure mode — guard against restart storms).
