# wedge-watchdog — SYS-WEDGE-AUTORESTART

Detect/remediate backstop for synchronized agent **session-wedges** (alive-but-stuck PTY,
e.g. a stalled Anthropic stream). Defense-in-depth alongside the onFire-timeout daemon fix
(SYS-CRON-FIRING-FLAG, containment) and SA's hourly hb-freeze alert (slow safety-net).

## Files
- `wedge-watchdog-lib.mjs` — pure `evaluateWedge(state) -> verdict`. Reviewed; 17 fixtures (`*-lib.test.mjs`).
- `wedge-watchdog-data.mjs` — data layer (ps process-tree CPU, empirical interval-derivation, activity, mode/io). 5 fixtures (`*-data.test.mjs`).
- `wedge-watchdog.mjs` — **main entry / launchd target** (control flow + restart path).
- `com.cortextos.wedge-watchdog.plist.template` — launchd job (deterministic, non-LLM, session-independent).

## Detection (the verdict)
A `restart` verdict requires ALL of:
- **Gate A** hb-frozen, **per-agent-interval-aware**: `now - last_heartbeat ≥ 2 × THAT agent's own heartbeat interval` (empirical closed-historical-median; never a global window — that was the 2026-06-18 advance-delta FP).
- **Gate B** never-reap-producing, both: **B1** process-**tree** CPU < 2% (catches a child build/rebase) AND **B2** no work produced in the window (`lastActivityMs` = newest of stdout.log mtime / commit / task-update / bus-message / state-dir write; stdout.log mtime = live-vs-dead-stream signal).
- **Gate C** daemon-alive-via-OTHERS: ≥1 other agent advancing+fresh at its own cadence; else **HOLD + alarm** (global pause / credit / daemon-down). Subsumes the orchestrator carve-out.

`none` for idle (Gate A), busy/child-build (Gate B), crashed (out of scope → SA hb-freeze alert). Cold-start agents (too few closed gaps) are skipped.

## Mode (off | shadow | armed) — the auditable arm-flip
Mode is read at RUNTIME from `<CTX_ROOT>/state/wedge-watchdog.mode` (absent/invalid ⇒ `off`, fail-safe).
The arm-flip is **one logged, reversible file-write — NO launchctl reload**:

```sh
# PD-owned arm-flip (only after zero-FP shadow evidence):
echo armed  > ~/.cortextos/default/state/wedge-watchdog.mode
# revert:
echo shadow > ~/.cortextos/default/state/wedge-watchdog.mode   # or: off
```
The runner logs a `MODE-TRANSITION` line to the shadow log on the next tick (the "when").
`CTX_WEDGE_WATCHDOG` env overrides the file (tests only).

## Outputs
- `state/wedge-watchdog-shadow.log` — JSONL, one line per non-`none` verdict with full gate/rail **trace** (incl `lastActivityAgoMs` + `lastActivitySource` so the residual silent-subprocess class surfaces).
- `state/wedge-watchdog-last-fire` — liveness timestamp (who-watches-the-watcher: SA's cron-tick-freshness backstop reads this).
- `state/wedge-watchdog-state.json` — per-agent cooldown (1 action / agent / 30 min; 2nd wedge in window ⇒ escalate, not loop) + `lastMode`.

## Install (host-specific — darwin / this machine; re-render on fleet migration)
Render the `{{...}}` in the template → `~/Library/LaunchAgents/com.cortextos.wedge-watchdog.plist`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cortextos.wedge-watchdog.plist`.
`StartInterval 300` is off-boundary by nature (fires relative to load, not wall-clock minutes — cron-stampede-safe).

## Security
`SEC-WEDGE-ARGV`: the restart path validates the agent name against `^[a-zA-Z0-9][a-zA-Z0-9-]*$` (primary) and uses a `--` argv sentinel (secondary; verified honored). Unsafe names are refused.
