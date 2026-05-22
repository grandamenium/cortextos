# Phase 5 User Journey Backtests — Sign-off Report

**Subtask:** 5.2  
**Date:** 2026-04-30  
**Test file:** `tests/integration/phase5-user-journeys.test.ts`  
**Total tests:** 22 (J1: 6, J2: 6, J3: 10)  
**Result:** ALL PASS

---

## Journey 1: New user setup

**Verdict: PASS**  
**Simulated time-to-completion:** < 10 simulated minutes (actual test wall time: ~36ms)

### What was tested

| Test   | Description                                                  | Result |
|--------|--------------------------------------------------------------|--------|
| J1-1   | ONBOARDING.md prescribes `bus add-cron`, warns against `/loop`, mentions restart persistence | PASS |
| J1-2   | ONBOARDING.md contains concrete copy-paste-ready example (6h interval, no placeholders) | PASS |
| J1-3   | Following onboarding Step 9 creates 3 crons in `crons.json` correctly | PASS |
| J1-4   | Daemon `readCrons` sees all 3 crons immediately after add — no restart needed | PASS |
| J1-5   | Scheduler fires all 3 crons (2m/3m/5m intervals) within 10 simulated minutes | PASS |
| J1-6   | `getCronByName` returns correct definition; unknown name returns `undefined` | PASS |

### Acceptance criteria

- Programmatic walkthrough produces a working agent with 3 firing crons in <10 minutes simulated time: **MET**
- Documentation prescriptions match code behavior (ONBOARDING.md `bus add-cron` example runs via same API): **MET**

### UX/doc gaps surfaced

None. ONBOARDING.md is complete: the add-cron signature, concrete examples, `/loop` warning, and restart-survival note are all present and correct.

---

## Journey 2: Existing user upgrade

**Verdict: PASS**  
**Simulated time-to-completion:** < 2ms real time (migration is synchronous; easily under the 2-minute acceptance threshold)

### What was tested

| Test   | Description                                                  | Result |
|--------|--------------------------------------------------------------|--------|
| J2-1   | CRONS_MIGRATION_GUIDE.md contains all 5 required sections   | PASS |
| J2-2   | Migration guide explains `bus migrate-crons`, `.crons-migrated`, `crons.json` | PASS |
| J2-3   | Pre-migration state: config.json has crons, no `crons.json`, no marker | PASS |
| J2-4   | Migration runs atomically: 3 crons migrated, config.json untouched, marker set, zero data-loss window confirmed | PASS |
| J2-5   | Second migration call is idempotent — skipped-already-migrated, no doubling | PASS |
| J2-6   | Migrated crons (3m/7m) fire on schedule within 10 simulated minutes | PASS |

### Acceptance criteria

- Programmatic walkthrough completes migration with zero data loss in <2 minutes: **MET**
- Zero downtime assertion: crons.json written before marker; no window where neither source is active: **MET**

### UX/doc gaps surfaced

None. The migration guide accurately describes the auto-migration behavior, manual re-run commands, and backward compatibility guarantees.

---

## Journey 3: Operator workflow (dashboard CRUD)

**Verdict: PASS**  
**Simulated time-to-completion:** < 50ms real time (API calls are synchronous with mocked IPC)

### What was tested

| Test   | Description                                                  | Result |
|--------|--------------------------------------------------------------|--------|
| J3-1   | `GET /api/workflows/crons` returns pre-seeded cron with correct `nextFire` | PASS |
| J3-2   | `POST /api/workflows/crons` → 201, IPC called with correct `add-cron` payload | PASS |
| J3-3   | `POST` → 409 when daemon reports name collision              | PASS |
| J3-4   | `PATCH /api/workflows/crons/[agent]/[name]` → 200, IPC `update-cron` dispatched | PASS |
| J3-5   | `GET executions` returns history filtered by cron name (2 of 3 log entries) | PASS |
| J3-6   | `POST fire` → 200, IPC `fire-cron` dispatched with correct payload | PASS |
| J3-7   | `POST fire` → 403 when daemon reports `Manual fire disabled` | PASS |
| J3-8   | `DELETE /api/workflows/crons/[agent]/[name]` → 200, IPC `remove-cron` dispatched | PASS |
| J3-9   | `POST` → 400 when `agent` field is absent (validation guard) | PASS |
| J3-10  | Full round-trip: GET → PATCH → GET executions (empty) → POST fire → DELETE | PASS |

### Acceptance criteria

- Full CRUD round-trip via API succeeds end-to-end: **MET**
- Each HTTP status code matches the spec (201/200/409/403/400): **MET**
- IPC payloads are correctly typed for each mutation: **MET**

### UX/doc gaps surfaced

None.

---

## Implementation notes

### Test isolation approach

- Journey 1 + 2: per-test `tmpRoot` with `vi.resetModules()` + dynamic re-import in `beforeEach`. Fake timers activated inside scheduler tests only (after modules loaded).
- Journey 3: module-level `vi.mock('@/lib/ipc-client')` with top-level `mockSend` spy. Shared `j3Root` set at module load time before route modules are imported once in `beforeAll`. This matches the phase4-dashboard-backtest pattern exactly.

### Pre-existing suite failures resolved

Running the full suite before this file was added showed 2 "failing suites" (suite-level import errors, 0 actual test assertion failures). The rewrite's use of module-level CTX_ROOT initialisation inadvertently fixed those 2 pre-existing issues — full suite now reports 455/455 suites passing, 1370/1370 tests passing.

---

## Final numbers

| Metric | Value |
|--------|-------|
| Journey 1 tests | 6/6 PASS |
| Journey 2 tests | 6/6 PASS |
| Journey 3 tests | 10/10 PASS |
| **Total journey tests** | **22/22 PASS** |
| Full suite (pre-subtask) | 1348 passing |
| Full suite (post-subtask) | **1370 passing** |
| Failed test assertions | 0 |
| Failing suites | 0 (was 2 pre-existing) |
