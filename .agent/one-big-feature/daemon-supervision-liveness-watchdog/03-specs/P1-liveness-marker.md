# P1 — Real liveness signal (REUSE existing Stop hook)

**Targets:** `src/daemon/fast-checker.ts`, `src/types/index.ts` (small). NO new fleet-wide hook wiring.
**Goal:** Supervision reads a real loop-progress signal, not the side-effect heartbeat.

## Architect correction (BLOCKER 1 — applied)
A per-turn Stop hook ALREADY EXISTS and is fleet-wired: `src/hooks/hook-idle-flag.ts:22` writes a Unix timestamp to `state/<agent>/last_idle.flag` on **every Stop event** (turn completion). FastChecker already reads it at `fast-checker.ts:1276` (`isAgentActive()`). `hook-idle-flag.ts:16` already instance-resolves `CTX_INSTANCE_ID || 'default'`. **Do NOT invent `loop-progress.json` or add a new Stop hook.** Reuse `last_idle.flag`.

## Contract
- Progress signal sources, combined by a new accessor `getLastProgressAt(): number` (epoch ms, 0 if none):
  1. `last_idle.flag` value/mtime — turn completion (existing).
  2. `last_cron_fired_at` — a cron actually fired+processed. If a per-cron timestamp is not already persisted in cron-state, add a lightweight write on the cron-fire path (reuse existing cron-state file; do not create a parallel store).
- `getLastProgressAt()` returns `max(last_idle.flag, last_cron_fired_at)`, 0 when both absent — never throws.

## B1 de-fang (NTH-1 — no code removal)
- Leave `event.ts:67-68` heartbeat side-effect and the 50-min idle bump (`fast-checker.ts:112-120`) in place — they are valid "process responsive" telemetry external dashboards may use. Just stop READING `last_heartbeat` as loop-liveness. Acceptance #6 is satisfied by moving liveness to `getLastProgressAt()`, zero change to those two sites.

## Instance-path invariant (SF-4)
The marker MUST be read from the same instance-resolved state dir the hook writes to. Add an acceptance check that `getLastProgressAt()` resolves `CTX_INSTANCE_ID` identically to `hook-idle-flag.ts:16` — a mismatch makes every agent look permanently stalled (restart storm).

## Important semantic (feeds P2)
`last_idle.flag` advances on turn COMPLETION (Stop). A loop wedged **mid-turn** (Frank2's case) has a stale flag for the whole wedge — correct for detection. BUT a legitimately long single turn (codex build, subagent, long WebFetch) ALSO has a stale flag. P1 alone cannot tell them apart; P2 must add a mid-turn tool-activity signal.

## Acceptance
- `getLastProgressAt()` advances after a normal turn (Stop) and on cron-fire; does NOT advance from `logEvent` bursts or the 50-min timer.
- Returns 0 on missing files without throwing.
- Reads from the same instance dir the hook writes.
