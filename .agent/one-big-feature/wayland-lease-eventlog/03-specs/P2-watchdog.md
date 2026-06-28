# P2 — Watchdog daemon loop

**Depends on P1 (`sweepStalledTasks`).** Deterministic background sweep — NOT a prompt-cron.

## Targets
- `src/daemon/fast-checker.ts` — mirror the existing idle-heartbeat `setInterval` pattern (125-133); add a sibling watchdog interval.
- (Or a dedicated `src/daemon/task-watchdog.ts` owning the interval, started from the same place `fast-checker` is started.) Prefer a dedicated module for testability; wire its start/stop into the daemon lifecycle alongside fast-checker.
- Agent config (`agents/<name>/config.json`) — `task_watchdog_enabled` flag.

## Behavior
- `setInterval` every **60s** (`WATCHDOG_INTERVAL_MS = 60_000`).
- Re-entrancy guard (`sweeping` boolean — pattern from doc Watchdog.ts:378) so a slow sweep never overlaps.
- Each tick: for each org the instance supervises, call `sweepStalledTasks(paths, org)`. Emit a `watchdog_sweep` summary event (via P3 `logEvent`) with counts `{ stalled, reclaimed, failed }` only when non-zero (SILENT-OK: no event when nothing happened).
- **Kill-switch:** read `task_watchdog_enabled` from agent/instance config. **Default: enabled** (this is recovery infra, not a restart action — unlike the stall-watchdog it does NOT kill processes, only re-queues task files, so the blast radius is bounded to task state). Provide the flag so an operator can disable per-instance.
- Runs on a single instance (the supervising daemon) — no multi-writer concern. Still relies on P1's per-mutation state guard for safety.

## Explicitly NOT
- Does NOT restart agents or touch processes (that is the separate stall-watchdog from `daemon-supervision-liveness-watchdog`). This watchdog only mutates task JSON.
- Does NOT do verify-orphan recovery (no `'verifying'` status).

## Acceptance
- With a synthetic expired `in_progress` task on disk, after one watchdog tick the task is `stalled`; after the next tick `pending` with `retries_used=1`.
- `task_watchdog_enabled=false` → no sweeps fire.
- Sweep is re-entrant-safe (overlapping ticks do not double-increment `retries_used` — covered by P1 guard + P4 test).
