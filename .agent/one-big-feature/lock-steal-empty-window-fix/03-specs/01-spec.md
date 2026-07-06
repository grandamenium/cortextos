# OBF Spec 01 — lock-steal-empty-window-fix

**Slug:** lock-steal-empty-window-fix · **Repo:** /Users/joshweiss/code/cortextos
**Base:** origin/main (8359a37+). Read source with `git show origin/main:src/utils/lock.ts` — the local
working tree is a stale snapshot; do NOT trust it.
**Author:** larry · **Date:** 2026-07-06

## Objective
Eliminate the double-acquire / throw / hang in `stealLock` under concurrent stale-lock stealing, so
`tests/unit/utils/lock.test.ts > "allows only one immediate stale-lock stealer per round"` is 100%
green under load. Fix the CLASS: **`lockDir` must never be observable in a pidless/empty state to any
racing actor.**

## Exact current code (origin/main src/utils/lock.ts)
- `restoreClaim` — lines 80-91. Catches only `ENOENT`/`EEXIST`.
- `stealLock` — lines 93-136. Publish sequence at 116 (`rmSync(claimPath)`) → 118 (`mkdirSync(lockDir)`)
  → 127 (`writeFileSync(pidFile, pid)`). The 118→127 gap is the empty window.
- `acquireLock` fast path — 145-187; missing/corrupt-pid grace at 180 (`ageMs < STALE_PID_GRACE_MS`).
- `STALE_PID_GRACE_MS = 500` (line 11).

## Required behavior after fix
1. **No pidless exposure.** When `lockDir` next becomes visible after a steal, a `pid` file with the
   new owner's pid must already be present (or the dir must be treated as young-and-mid-acquire by
   every observer, including stealers).
2. **Stealers honor the same grace as the fast path.** After a stealer wins its `renameSync(lockDir→
   claimPath)`, if the claimed dir's pid is missing/corrupt AND the dir age < `STALE_PID_GRACE_MS`, it
   must NOT steal — it must `restoreClaim` and return `false` (a peer is mid-acquire). Only a genuinely
   dead/expired owner is steal-able.
3. **No throw on a lost race.** `restoreClaim` and any publish step must catch `ENOENT`, `EEXIST`, AND
   `ENOTEMPTY` and translate to `return false` (lost the race / already restored). Never let these
   escape as errors.
4. **Exclusive create stays `mkdirSync`.** Never publish via `renameSync(claim → lockDir)` onto a
   possibly-existing target (POSIX rename-onto-empty-dir silently replaces → double ownership).

## Implementation guidance (codexer to finalize against the oracle)
Rewrite the `stealLock` publish block (currently 116-132) so that:
- Our pid is written into the private `claimPath` first: `writeFileSync(join(claimPath, 'pid'),
  String(process.pid))` — while the dir is still private and un-observable.
- Reserve the lock with the exclusive primitive: `mkdirSync(lockDir)` (EEXIST ⇒ `return false`).
- Immediately populate the pid: `writeFileSync(pidFile, String(process.pid))` with nothing observable
  in between. (If a design writes pid into the claim then moves the pid FILE — not the dir — into the
  freshly-mkdir'd lockDir, that is acceptable IFF the dir is never observable pidless; justify it.)
- On any `writeFileSync` failure, roll back (`rmSync(lockDir, {recursive,force})`) and rethrow only if
  it is NOT a lost-race code.
- `finally { rmSync(claimPath, {recursive, force:true}); }` stays.

Extend `restoreClaim` to also catch `ENOTEMPTY`.

Add the stealer-side grace check (requirement 2) using `lockAgeMs`/`readObservedOwner` — mirror the
fast-path logic at lines 180-183 but applied to the claimed dir after winning the rename.

If, after honest interleaving analysis, a cleaner correct structure emerges (e.g. a single
`mkdirSync`-reserve-then-populate with the stealer grace making the window unobservable), that is fine —
**the acceptance criterion is the oracle below, plus a written interleaving argument**, not adherence
to a specific line-by-line rewrite.

## Proof / acceptance (MANDATORY — measured, not asserted)
1. `npm run build` clean.
2. Targeted 100x: `for i in $(seq 100); do npx vitest run tests/unit/utils/lock.test.ts -t "allows only one immediate stale-lock stealer per round" >/tmp/lk-$i.log 2>&1 || { echo "FAIL run $i"; break; }; done; echo done` — **100/100 pass, no 20s timeouts.** Paste the pass count + any failing log.
3. Full-file 20x: `for i in $(seq 20); do npx vitest run tests/unit/utils/lock.test.ts || break; done` — 20/20 green.
4. Confirm the OTHER lock tests (grace, restore, mutex rmw) still pass — no regression.
5. `git show <commit> --stat` → scope is `src/utils/lock.ts` (and only optionally the test file).

## Scope (exact)
- `src/utils/lock.ts` — `stealLock` + `restoreClaim` only.
- Do NOT touch: public signatures, `acquireLock` fast path semantics, `releaseLock`, `withFileLockSync`,
  `STALE_PID_GRACE_MS`, or any other file.

## Constraints
- TS strict; no new `any`; no `console.*`; no new deps.
- Branch `feat/lock-steal-empty-window-fix` off origin/main. Commit only — NO push, NO PR.
- Return: commit sha, `git show <sha>` diff, scope report, and the raw 100x + 20x oracle outputs.

## Handback — what larry re-runs independently before PR
- Re-run the 100x targeted loop AND the 20x full-file loop myself in an isolated worktree (must be
  fully green — I will not accept a claim).
- Adversarial review: interleaving argument holds, no rename-onto-existing publish, ENOTEMPTY handled,
  no new `any`/`console`, scope exact.
- Then PR via `gh api repos/clearworks-ai/cortextos/pulls --method POST` (gh pr create glitches).
