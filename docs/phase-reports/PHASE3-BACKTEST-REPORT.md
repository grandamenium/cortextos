# Phase 3 Full Backtesting Report — Subtask 3.5

**Date**: 2026-04-30
**Branch**: feat/external-persistent-crons
**Test file**: tests/integration/phase3-docs-backtest.test.ts
**Status**: PASSED — all 28 tests green (after 2 doc fixes surfaced by backtest)

---

## Summary

Four user-journey scenarios were run against the Phase 3 documentation set
(ONBOARDING.md, CRONS_MIGRATION_GUIDE.md, cron-management/SKILL.md, AGENTS.md).
Each scenario:

1. Reads the relevant doc from disk and asserts key prescriptive sections exist
2. Programmatically executes the doc-prescribed steps using real disk I/O in tmp dirs
3. Asserts the documented outcome occurs

The backtest surfaced **2 real documentation gaps** that were fixed before finalizing.
No mocks used. No fake timers except in Scenario 3f (disabled-cron scheduler test).
All 28 tests pass. Full suite: 1019 tests, 0 failures.

---

## Methodology

Each scenario maps to a distinct real-world user journey:

| Scenario | User | Doc Under Test | Steps Validated |
|----------|------|----------------|-----------------|
| 1: New user onboarding | First-time agent setup | `templates/agent/ONBOARDING.md` | add-cron creates crons.json, daemon reads it, persistence confirmed |
| 2: Existing user upgrade | Operator with legacy config.json crons | `CRONS_MIGRATION_GUIDE.md` | auto-migration, no data loss, idempotency, --force, non-scary message |
| 3: Operator CRUD via skill docs | Agent managing its own crons | `community/skills/cron-management/SKILL.md` | add → list → test-fire → get-log → remove; update; disable/enable; scheduler-disabled |
| 4: Support troubleshooting | Person debugging a missing cron | Both docs (Troubleshooting sections) | 4 failure modes covered + programmatic simulation of each |

---

## Scenario Results

### Scenario 1: New User Onboarding (ONBOARDING.md Step 9)

**Result**: PASSED (5 tests)

**Doc assertions (1a, 1b):**
- ONBOARDING.md instructs `bus add-cron` as the persistent cron creation command
- Doc warns against `/loop` (session-only, dies on restart)
- Doc contains concrete copy-paste examples (e.g., `heartbeat 6h`, `daily-report "0 9 * * 1-5"`)

**Doc gap surfaced and fixed**: The original ONBOARDING.md had only a template placeholder
(`<workflow-name> <interval> <prompt>`) with no concrete examples. Test 1b correctly failed.
Fix: added two concrete `bus add-cron` examples below the template form.

**Programmatic assertions (1c, 1d, 1e):**
- Following Step 9 (`bus add-cron <agent> heartbeat 6h <prompt>`) creates `crons.json` on disk
- `crons.json` is absent before the command, present after — persistence confirmed
- `readCrons()` (same code path as CronScheduler on start) returns the cron immediately
- `getCronByName()` lookups succeed; non-existent name returns `undefined`

---

### Scenario 2: Existing User Upgrade (CRONS_MIGRATION_GUIDE.md)

**Result**: PASSED (5 tests)

**Doc assertions (2a, 2b, 2c):**
- All required sections present: What Changed, What You Need to Do, Verification, Troubleshooting, Backward Compatibility
- "What You Need to Do" opens with "Nothing. Migration runs automatically" — clear and non-scary
- References `.crons-migrated` marker and `crons.json` as the target store
- Provides `cortextos bus migrate-crons` and `--force` for manual override

**Programmatic assertions (2d–2h):**
- Auto-migration from config.json `crons` array creates `crons.json` + marker
- `status: migrated`, `cronsMigrated: 2`, `cronsSkipped: []` for clean input
- No data loss: every config.json cron name appears in crons.json (schedules preserved)
- Idempotency: second migration returns `skipped-already-migrated`, crons.json unchanged
- `--force` clears marker, re-runs, recreates marker
- Non-scary message: "What You Need to Do" section matches `/Nothing|automatic/i`; no DANGER/BREAKING CHANGE language

---

### Scenario 3: Operator Adds Crons via Skill Docs (cron-management/SKILL.md)

**Result**: PASSED (6 tests)

**Doc assertions (3a, 3b):**
- SKILL.md documents all prescribed subcommands: `add-cron`, `list-crons`, `remove-cron`, `update-cron`, `test-cron-fire`, `get-cron-log`
- Has a Troubleshooting section
- Examples are syntactically correct (have agent placeholder + name + schedule)
- Multiple `add-cron` examples covering interval and cron-expression forms

**Programmatic CRUD sequence (3c–3f):**
- `add-cron` → `readCrons` shows cron; `appendExecutionLog` → `getExecutionLog` shows fired entry; `removeCron` removes it; `readCrons` returns empty
- `update-cron` changes schedule from `1h` to `4h` on disk
- `update-cron --enabled false` disables; `--enabled true` re-enables
- CronScheduler with a disabled cron: `getNextFireTimes()` returns `[]`; 5-minute fake-timer advance produces 0 fires

---

### Scenario 4: Support Troubleshooting a Missing Cron

**Result**: PASSED (9 tests)

**Doc coverage assertions (4a, 4b, 4i):**
- CRONS_MIGRATION_GUIDE.md Troubleshooting covers: "Migration did not run", "Cron not firing", `list-crons`, `get-cron-log`, `cortextos bus migrate-crons`
- SKILL.md Troubleshooting covers: `list-crons` as step 1, `get-cron-log`, daemon reload, disabled cron check
- Combined docs cover all 4 required failure modes (see Coverage Analysis below)

**Doc gap surfaced and fixed**: Neither doc mentioned malformed/corrupt `crons.json` in Troubleshooting.
Test 4i correctly failed. Fix: added "Malformed or empty crons.json" section to CRONS_MIGRATION_GUIDE.md
with diagnosis and recovery steps.

**Programmatic failure mode simulations (4c–4h):**
- Missing crons.json: `readCrons()` returns `[]`; `isMigrated()` returns `false`
- Manual `migrate-crons` fixes missing cron (doc step 2)
- Stale `.migrated` marker with no crons.json: normal run skips (stale marker wins); `--force` recovers
- Malformed crons.json: `readCrons()` returns `[]` without throwing (graceful degradation)
- No log file: `getExecutionLog()` returns `[]` without throwing
- Empty crons.json: CronScheduler starts with 0 scheduled crons, `getNextFireTimes()` returns `[]`

---

## Doc Clarity Scores

Scoring on a 1-5 scale (5 = copy-paste ready, no ambiguity; 1 = missing or misleading).

| File | Score | Notes |
|------|-------|-------|
| `templates/agent/ONBOARDING.md` (Step 9 cron block) | 4/5 | Clear warning against /loop; good structure. Needed concrete examples added (fixed). |
| `CRONS_MIGRATION_GUIDE.md` | 4/5 | "Nothing" opener is ideal. Troubleshooting good but lacked corrupt-file coverage (fixed). `Architecture Reference` table is a strong addition. |
| `community/skills/cron-management/SKILL.md` | 5/5 | Excellent. Full CRUD with copy-paste examples, sample output, troubleshooting, one-shot gap documented with workaround. No stale patterns. |
| `templates/agent/AGENTS.md` (External Persistent Crons section) | 5/5 | Three concrete `bus add-cron` examples (interval, cron-expr, offset), How to Verify section, migration explanation, no stale patterns. Already validated by phase3-docs.test.ts (Subtask 3.1). |

---

## Troubleshooting Coverage Analysis

### Failure Modes Covered (4/4 required)

| Failure Mode | Coverage Location | How Covered |
|---|---|---|
| Missing crons.json (migration never ran) | CRONS_MIGRATION_GUIDE.md "Migration did not run" | "No marker file? Run `bus migrate-crons` manually." |
| Stale .migrated marker | CRONS_MIGRATION_GUIDE.md "Migration did not run" + Backward Compatibility | `--force` flag documented; marker delete + re-migrate described |
| Daemon not running / scheduler not reloaded | SKILL.md Troubleshooting "Just-added cron not registered" | `bus migrate-crons --force` to force reload; also in migration guide |
| Malformed / empty crons.json | CRONS_MIGRATION_GUIDE.md "Malformed or empty crons.json" | Added by this backtest pass — delete + force re-migrate |

### Additional Failure Modes Covered (bonus)

| Mode | Location |
|---|---|
| Cron fires but agent does not react (PTY injection) | CRONS_MIGRATION_GUIDE.md + SKILL.md |
| Cron failing repeatedly (prompt/permission errors) | SKILL.md `get-cron-log` + error field |
| Disabled cron not firing | SKILL.md "Disabling without deleting" |
| One-shot cron not supported in external system | SKILL.md "One-shot reminders (gap)" — honest about limitation |

**Total failure modes documented: 8+** (well above the 80% target; all common real-world scenarios covered)

---

## Doc Fixes Applied During Backtest

Two documentation gaps were surfaced programmatically and fixed as part of this subtask:

### Fix 1: ONBOARDING.md — Missing Concrete Examples

**File**: `templates/agent/ONBOARDING.md`
**Gap**: Step 9 showed only a template placeholder `<workflow-name> <interval> <prompt>` with no copy-paste-ready examples. Users following the guide would have no reference for correct syntax.
**Fix**: Added two concrete examples below the template form:
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h Read HEARTBEAT.md and follow its instructions.
cortextos bus add-cron $CTX_AGENT_NAME daily-report "0 9 * * 1-5" Generate and send the daily analytics report.
```
**Test**: Scenario 1, test 1b now passes.

### Fix 2: CRONS_MIGRATION_GUIDE.md — Missing Malformed crons.json Troubleshooting

**File**: `CRONS_MIGRATION_GUIDE.md`
**Gap**: Troubleshooting section did not address the case of a malformed or accidentally emptied `crons.json`. This is a real failure mode (e.g., from a failed atomic write, manual edit error, or disk issue) that would leave operators confused about why all crons silently vanished.
**Fix**: Added "Malformed or empty crons.json" troubleshooting entry with diagnosis and recovery steps.
**Test**: Scenario 4, test 4i now passes.

---

## Total Test Coverage

| Scenario | Tests | Result |
|---|---|---|
| 1: New user onboarding | 5 | PASS |
| 2: Existing user upgrade | 5 | PASS |
| 3: Operator CRUD via skill docs | 6 | PASS |
| 4: Support troubleshooting | 9 | PASS |
| **Total** | **28** | **28/28 PASS** |

**Full suite**: 1019 tests, 0 failures. No regressions introduced.

---

## Sign-off

Phase 3 documentation backtesting is **complete**. All 4 user-journey scenarios are validated.

Documentation is ready for users:
- Commands are copy-paste ready (concrete examples, not just templates)
- Migration is non-scary ("Nothing. Migration runs automatically.")
- Troubleshooting covers all common failure modes including malformed state
- No stale patterns (CronList-first, "crons die on restart") in any doc
- SKILL.md is the authoritative operator reference; ONBOARDING.md, AGENTS.md, and CRONS_MIGRATION_GUIDE.md are consistent with it

**Phase 3: COMPLETE. Ready for Phase 4 (Dashboard Integration).**
