# P4 — Tests (env-clean)

**PR-blocking.** Vitest, `{subject}.test.ts`, `mkdtempSync`/`rmSync` temp dirs (pattern: `tests/unit/bus/cron-state.test.ts`). Run env-clean (scrub `CTX_*` vars) per `feedback_cortextos_test_env_clean_first`.

## Files
- `tests/unit/bus/task-lease.test.ts`
- `tests/unit/bus/task-watchdog-sweep.test.ts` (sweep logic — pure, no daemon)
- `tests/unit/bus/event-log.test.ts`
- (optional) `tests/unit/daemon/task-watchdog.test.ts` if the interval module is split out (fake timers)

## Cases

### Lease (`task-lease.test.ts`)
1. `claimTask` sets `lease_owner`, `lease_expires_at ≈ now+3min`, `retries_used=0`, `retry_budget=3`.
2. update→`in_progress` on a leaseless task sets the lease.
3. `renewLease` by owner extends `lease_expires_at`; `lease_renewed_at` advances.
4. `renewLease` by non-owner returns `false`, leaves lease unchanged.
5. `completeTask` clears `lease_owner`/`lease_expires_at`, preserves `retries_used`.
6. **Backward-compat:** a legacy task JSON with NO lease fields loads, lists, updates, completes without error.

### Sweep (`task-watchdog-sweep.test.ts`)
7. Expired `in_progress` (lease_expires_at in past) → `stalled` after one sweep.
8. `stalled` with budget remaining → `pending`, `retries_used+1`, lease cleared.
9. `stalled` at budget → `failed` with advisory `result`.
10. Leaseless `in_progress` task is NEVER touched by sweep.
11. Re-entrancy: two sequential sweeps on the same stalled task do not double-increment `retries_used` beyond budget.

### Event log (`event-log.test.ts`)
12. `logEvent` with `target` writes `target` into the JSONL record; without `target` the field is absent (backward-compat parse).
13. `claimTask` emits `task_started`; `completeTask` emits `task_completed` (assert via `readEvents`).
14. `sweepStalledTasks` emits `task_stalled` then `task_reclaimed`.
15. `readEvents({org, since})` returns emitted events ordered desc; `eventType` filter narrows; `agent` filter scopes to one dir; date bound excludes out-of-range partitions.

## Gate
- `npm run build` clean.
- `npm test` green env-clean.
- No `any`, no `console.log` in shipped src.
