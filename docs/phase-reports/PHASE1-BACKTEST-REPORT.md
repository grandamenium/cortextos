# Phase 1 Backtesting Report

**Date**: 2026-04-30
**Branch**: feat/external-persistent-crons
**Test file**: `tests/integration/phase1-backtesting.test.ts`
**Result**: ALL 6 SCENARIOS PASSED (9 test cases)

---

## Summary

Full integration backtesting of the external persistent cron system (Subtasks 1.1-1.5).
All tests use real disk I/O against per-test temp CTX_ROOT directories.
No module mocking — every layer (types, bus/crons.ts, cron-scheduler.ts, cron-execution-log.ts) runs real code.
Timing driven by `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` — the 72h simulation completes in under 730ms wall time.

---

## Scenarios

### Scenario 1: Normal operation (5 agents, 10 crons, 72h sim)

**Status**: PASSED | **Wall time**: 726ms

- 5 agents, 10 crons across interval shorthands (`1h`, `6h`, `24h`, `12h`) and cron expressions (`0 * * * *`, `0 0,6,12,18 * * *`, `0 9 * * 1-5`, `*/30 * * * *`, `0 0 * * *`, `0 6 * * *`).
- 72h simulated in 4320 one-minute steps.
- Every cron fired within its expected range (±1 fire tolerance).
- Execution log `fired` entries matched actual fire counts for all 10 crons.

**Cron fire accuracy**: All within expected windows. The cron expression parser evaluates next-fire at whole-minute granularity; tick fires at 30s intervals, so maximum timing error is 30 seconds. Log timestamps show zero gaps or double-fires.

### Scenario 2: Daemon crash recovery

**Status**: PASSED | **Wall time**: 16ms

- Scheduler ran 3+ hours, then was stopped (simulating crash).
- `crons.json` verified on disk with `last_fired_at` and `fire_count` intact.
- 90 minutes of simulated downtime elapsed before restart.
- Fresh scheduler instance instantiated from same disk state.
- Catch-up fire confirmed on first tick after restart (within one 30s tick period).
- Subsequent fires continued on schedule — no duplicate fires for the same slot.
- `fire_count` on disk matched total fires observed.

**Recovery time**: 1 tick (30 seconds simulated) from scheduler start to catch-up fire.

### Scenario 3: Corrupted crons.json

**Status**: PASSED | **Wall time**: 27ms

- Two agents running normally for 2h.
- Agent B's `crons.json` overwritten with malformed JSON mid-simulation.
- `scheduler.reload()` called — graceful degradation: returned empty schedule, logged parse error.
- Agent A continued firing unaffected (isolation confirmed).
- Agent B's scheduler returned 0 active crons after reload.
- `crons.json` restored with a new cron definition; fresh scheduler instantiated.
- Fires resumed within 1h of restore.

**Isolation**: Corruption of one agent's state file does not affect other agents. Parse errors are logged to stderr, never thrown.

### Scenario 4: PTY injection failure / retries

**Status**: PASSED (3 test cases) | **Wall time**: 2ms each

**Test 4a — Partial retry (succeeds on attempt 3):**
- Mock threw on attempts 1 and 2, succeeded on attempt 3.
- Log: 2 entries `status=retried` (attempts 1, 2) + 1 entry `status=fired` (attempt 3).
- Error messages populated in retried entries, `null` in fired entry.

**Test 4b — Total exhaustion (all 4 attempts fail):**
- Mock threw on all 4 attempts.
- Log: 3 entries `status=retried` + 1 entry `status=failed` (attempt 4).
- Scheduler did not crash; logged "giving up" message.
- `updateCron` not called (no fire_count increment on failure).

**Test 4c — Retry timing validation:**
- Measured `Date.now()` at each call via fake timers.
- Gap 1 (after attempt 1): 1000ms (matches 1s backoff).
- Gap 2 (after attempt 2): 4000ms (matches 4s backoff).
- Gap 3 (after attempt 3): 16000ms (matches 16s backoff).
- Timing matched within ±1000ms tolerance (fake timer precision).

**Retry backoff schedule**: 1s → 4s → 16s. Total max retry window: 21 seconds.

### Scenario 5: Concurrent cron fires

**Status**: PASSED (2 test cases) | **Wall time**: 5ms / 3ms

**Test 5a — 5 interval crons (catch-up fire):**
- All 5 crons had `last_fired_at` 25h ago; all had `nextFireAt = now` on scheduler start.
- All 5 fired sequentially within the first tick.
- All 5 log entries present with `status=fired`.
- `crons.json` atomic writes: all 5 `last_fired_at` fields updated, all `fire_count=1`.
- No lost updates — atomic write via `atomicWriteSync` (temp-file + rename) prevents torn writes.

**Test 5b — 3 cron-expression crons (same schedule):**
- All 3 used `*/5 * * * *`; all fired at same tick boundary.
- All 3 present in log after one scheduling window (5 min + one tick).

**Race conditions**: None observed. Sequential iteration in `tick()` combined with atomic disk writes prevents state corruption even when multiple crons fire in the same tick.

### Scenario 6: Log integrity end-to-end

**Status**: PASSED | **Wall time**: 165ms (24h simulation)

- 3 agents, 6 crons, 24h simulation.
- Post-simulation integrity checks:
  - No orphaned log entries (entries for non-existent crons).
  - No cross-agent log contamination (entries only appear in their owning agent's log).
  - No missing entries: `fired` log count == actual observed fire count for every cron.
  - Total `fired` entries across all agents == sum of `fireCounts` map.
  - All `fired` entries have `error=null`.
  - All `retried`/`failed` entries have non-null `error`.
  - All entries have required fields: `ts`, `cron`, `attempt >= 1`, `duration_ms >= 0`.

**Log completeness**: 100% across all agents and cron schedules.

---

## Metrics

| Metric | Value |
|---|---|
| Scenarios passing | 6/6 |
| Test cases | 9/9 |
| 72h simulation wall time | ~730ms |
| 24h simulation wall time | ~165ms |
| Cron fire timing accuracy | Within 30s (one tick interval) |
| Log completeness | 100% |
| Crash recovery time | 1 tick (30s simulated) |
| Retry timing accuracy | ±1000ms vs expected backoff |
| Atomic write race conditions observed | 0 |
| Orphaned log entries | 0 |
| Missing log entries | 0 |
| Regressions in existing 797 tests | 0 |

---

## Architecture Notes

**Timer strategy**: `vi.useFakeTimers()` intercepts the scheduler's `setInterval` (30s tick) and `fireWithRetry`'s `setTimeout` (retry delays). No test seam added to the scheduler — public API (`start`, `stop`, `reload`) is sufficient.

**No scheduler modifications required**: The scheduler's `tick()` method is private but driven entirely through `vi.advanceTimersByTimeAsync()`. The fake timer runtime processes nested async timers (retry `setTimeout` chains) within a single `advanceTimersByTimeAsync` call.

**CTX_ROOT isolation**: Both `crons.ts` and `cron-execution-log.ts` read `process.env.CTX_ROOT` at call time (not import time), so per-test temp dirs work without module resets for disk paths. `vi.resetModules()` is still called to prevent any module-level state accumulation across tests.

---

## Sign-off

Phase 1 (Subtasks 1.1-1.5) is validated and ready for production use. All critical failure modes (crashes, corruption, retry exhaustion, concurrent fires) have been tested and handled correctly by the implementation.
