# OBF Master Plan — lock-steal-empty-window-fix

**Framework:** one-big-feature
**Repo:** /Users/joshweiss/code/cortextos
**Slug:** lock-steal-empty-window-fix
**Author:** larry
**Date:** 2026-07-06
**Base:** origin/main (8359a37+) — verify src via `git show origin/main:src/utils/lock.ts`, NOT the working tree.

## Problem (1 HIGH — concurrency correctness in the load-bearing mutex)

`tests/unit/utils/lock.test.ts > "allows only one immediate stale-lock stealer per round"`
fails under full-suite / 4-way contention (CI = "expected length 1 but got 2"; local repro = 20s
timeout). **Reproduced on CLEAN origin/main (014f5f8) — run 5/8** — so it is a real residual race in
`stealLock`, not a test artifact and not caused by any recent PR. (The `acquire-once` worker does a
SINGLE non-retrying `acquireLock()`, so two `acquired:true` results = a genuine double-acquire.)

### Root cause (exact, from reading src/utils/lock.ts on origin/main)
`stealLock` (lines 93–136) publishes the reclaimed lock in a **non-atomic 3-step** sequence:
```
116  rmSync(claimPath, …)          // remove the stolen (validated-dead) dir
118  mkdirSync(lockDir)            // recreate EMPTY lock dir  ← observable window opens
127  writeFileSync(pidFile, pid)  // write owner pid          ← window closes
```
Between 118 and 127, `lockDir` exists but is **empty / has no pid file**. Two ways this breaks under
contention:

1. **Stealer bypasses the grace.** A *fast-path* acquirer that sees this window is protected by
   `STALE_PID_GRACE_MS` (line 180: missing/corrupt pid AND age < 500ms ⇒ back off). But a concurrent
   **stealer** already read `owner = dead` from the ORIGINAL seeded lock *before* calling `stealLock`,
   and after winning its own `renameSync(lockDir→claimB)` it validates against that stale `dead`
   expectation — it never re-applies the missing-pid grace to the freshly-published dir. So it can
   rename the winner's half-built lockDir away → double-acquire, or force the winner's `writeFileSync`
   (line 127) to ENOENT-throw (line 128–130), or leave lockDir owner-less → retry-storm → 20s hang.
2. **`restoreClaim` doesn't handle `ENOTEMPTY`.** Line 86 catches only `ENOENT`/`EEXIST`. On Linux &
   macOS, `renameSync(claim → existing-NON-empty lockDir)` throws **`ENOTEMPTY`**, which propagates as
   an uncaught error → spurious failure under the interleavings above.

## Fix — publish the reclaimed lock atomically-with-owner; never expose an empty/pidless lockDir

Target: the moment `lockDir` becomes observable again it must ALREADY contain a valid `pid` file, so
no observer (stealer or fast-path) ever sees a pidless dir it can race on.

**Primary approach (implement + validate against the oracle):**
- In `stealLock`, after `renameSync(lockDir→claimPath)` succeeds and `matchesExpectedOwner` passes,
  **stamp our pid INTO the private claim dir** (`writeFileSync(join(claimPath,'pid'), String(process.pid))`)
  while it is still private, THEN publish with a single atomic step.
- Publishing safely is the crux. `mkdirSync(lockDir)` is the ONLY portable exclusive-create primitive —
  keep it as the gate. Sequence: `mkdirSync(lockDir)` (EEXIST ⇒ someone else won ⇒ return false),
  then IMMEDIATELY `writeFileSync(pidFile, pid)` with NO intervening awaitable/observable step, then
  `rmSync(claimPath)` in `finally`.  The residual mkdir→writeFile window must be closed for STEALERS
  too: make **every** stealer honor the same missing/corrupt-pid grace the fast path uses — i.e. after
  winning its rename, if the claimed dir's pid is missing/corrupt AND the dir is young (< grace),
  `restoreClaim` and return false instead of stealing a mid-acquire peer.
- Add `ENOTEMPTY` (and `ENOENT`) handling to `restoreClaim` (line 80-91) and to any new publish rename:
  a collision means we lost the race ⇒ clean up claim, return false; never throw on a lost race.

> ⚠️ Do NOT publish via `renameSync(claimPath → lockDir)` onto a possibly-existing target: POSIX
> `rename(dir→existing-EMPTY-dir)` SILENTLY REPLACES, which would clobber a fast-path peer's reserved
> (mkdir'd, pid-not-yet-written) lockDir and re-introduce double-ownership. Exclusive create =
> `mkdirSync` only.

The implementer MUST reason through each 2-/3-/4-way interleaving in the report and show WHY it now
yields exactly one winner (or a clean `false`/retry), never two and never a throw.

## Proof / acceptance (the oracle is the test, run to convergence)
- The existing test `allows only one immediate stale-lock stealer per round` must pass **100/100
  consecutive runs** (loop it: `for i in $(seq 100); do npx vitest run …lock.test.ts -t "allows only one immediate stale-lock stealer per round" || break; done`), zero failures, zero 20s timeouts.
- The FULL `tests/unit/utils/lock.test.ts` suite green **20/20 consecutive runs** (it has other steal /
  grace / mutex tests that must not regress).
- `npm run build` clean.
- Include the raw loop output (pass counts) in the report — no "should be fine" claims.

## Scope (exact files)
- `src/utils/lock.ts` — `stealLock` (93-136) and `restoreClaim` (80-91) only. Do NOT change public
  signatures, `acquireLock`/`releaseLock`/`withFileLockSync` behavior, or `STALE_PID_GRACE_MS` value.
- (Optional) `tests/unit/utils/lock.test.ts` — ONLY if a deterministic interleaving assertion is added;
  do not weaken or delete the existing failing test. Prefer leaving the test file untouched.

## Constraints
- TypeScript strict, no new `any`, no `console.*`.
- No new deps. Reuse existing fs primitives already imported.
- Branch `feat/lock-steal-empty-window-fix` off origin/main. Commit only — do NOT push/PR (larry
  re-runs the 100x oracle himself, adversarially reviews, then PRs; Josh merges).

## Lessons Consulted
- SCOPE_LOCK — spec written from reading real origin/main `src/utils/lock.ts` (lines 80-187) + the
  `lock.test.ts` worker harness (acquire-once = single non-retrying acquire), not the working tree.
- `feedback_fix_once_dont_narrate_recurring_bugs` — #74 claimed the steal TOCTOU was closed; a window
  remained. Close the CLASS (never expose a pidless lockDir), don't patch one symptom.
- `feedback_agents_claim_live_without_verifying_deploy` — acceptance is 100x green, measured, not asserted.
- This is the flake that reddened #76/#77 CI; fixing it unblocks all future PR CI.
