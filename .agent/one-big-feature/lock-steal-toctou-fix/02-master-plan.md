# OBF Master Plan — A1 lock.ts concurrency hardening

**Slug:** lock-steal-toctou-fix
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature (single cohesive fix, one file + tests, no schema/multi-repo)
**Source of truth:** Fable bug-hunt 2026-07-06 cluster A1 (8 findings, 5 HIGH). See state/fable-bughunt-2026-07-06.md.

## Problem (proven from source: src/utils/lock.ts)
`src/utils/lock.ts` implements a `mkdir`-based inter-process mutex (`acquireLock`/`releaseLock`/`withFileLockSync`).
Three defects:

1. **steal-TOCTOU (HIGH, live-repro'd 6/200).** The stale-lock recovery path (lines ~56-66) does
   `rmSync(lockDir, {recursive,force}) → mkdirSync(lockDir) → writeFileSync(pidFile)`. This sequence is NOT
   atomic against a second concurrent stealer: stealer C's unconditional `rmSync(lockDir, force:true)` can
   delete a lock dir that stealer B *just* freshly created and already returned `true` on. Result: B believes
   it holds the lock, C also holds → two live holders → the exact RMW corruption withFileLockSync exists to
   prevent. This undermines PR #71's atomicity guarantee under a dead-holder-steal.

2. **releaseLock has no ownership check (HIGH).** `releaseLock` (lines ~73-80) unconditionally
   `rmSync(lockDir, force:true)`. If a steal race transferred ownership, the non-owner's release deletes the
   *current owner's* lock dir → a third acquirer can enter while the owner still runs `fn()`.

3. **crash-mid-acquire deadlock / corrupt-pid unrecoverable (HIGH).** A holder that dies between
   `mkdirSync(lockDir)` and `writeFileSync(pidFile)` leaves a lock dir with a missing pid file. The contention
   path (lines ~33-40) treats missing pid as "holder mid-acquire → return false, retry" *forever* — the dead
   holder never writes, so every contender spins to timeout and throws. Same for a corrupt/NaN pid (lines
   ~42-48): never stolen → permanently wedged.

## Fix strategy (design — codexer implements, Larry reviews)
- **Atomic steal via rename, not rmSync+mkdir.** To reclaim a stale lock, atomically
  `renameSync(lockDir, uniqueClaimDir)` where `uniqueClaimDir` includes `process.pid` + a monotonic counter.
  `renameSync` of a given source path is atomic: only ONE concurrent stealer wins the rename; the loser gets
  `ENOENT` → returns false. The winner then `rmSync(uniqueClaimDir)` + `mkdirSync(lockDir)` + writes its pid.
  If that post-steal `mkdirSync` throws `EEXIST`, a fresh acquirer legitimately took the empty slot first →
  return false (no double-hold). Optionally read-back the pid file and confirm it equals `process.pid` before
  returning true (defensive ownership verify).
- **Ownership-checked release.** `releaseLock` reads `pidFile`; only `rmSync` when it equals `process.pid`
  (or when the pid is dead/corrupt — safe to clean). Never delete a dir owned by a live different pid.
- **Bounded stale recovery for missing/corrupt pid.** Give a mid-acquire holder a short grace window
  (statSync mtime age vs a small threshold, e.g. 2× maxBackoff or a fixed few hundred ms). Missing/NaN/empty
  pid AND lock dir older than grace → treat as stale, steal atomically (same rename path). Fresh (< grace) →
  return false and let the caller retry (real mid-acquire holder).
- Preserve existing correct behavior: EEXIST-only contention (non-EEXIST errors still propagate), live-pid
  holder still refused, `withFileLockSync` retry/backoff/timeout semantics unchanged.

## Definition of done
- `npm run build` clean; no `any`, no `console.log`.
- Test-first proof (see 03-specs/01-lock-hardening.md): a multi-process/multi-worker barrier race asserting
  **exactly one holder at any instant** across N contenders, incl. a pre-seeded dead-pid stale-lock scenario
  and a missing-pid crash-mid-acquire scenario. Each new test must FAIL on current lock.ts and PASS after.
- Existing lock/withFileLockSync tests still green.

## Lessons Consulted
- `feedback_agents_claim_live_without_verifying_deploy` — every fix proven with a failing→passing test, never a claim.
- `feedback_fix_once_dont_narrate_recurring_bugs` — the lock has been patched before (iter-12 comment in-source); this is the durable single-site cure via atomic rename-claim, not another band-aid.
- SCOPE_LOCK (CLAUDE.md) — spec written from reading the real source (src/utils/lock.ts:1-144, all three defect sites enumerated with line refs), not a summary; scope = 1 file + 1 test.
- `feedback_certainty_via_orchestrated_verify_swarm` — the exactly-one-holder proof uses REAL concurrency (worker_threads/child procs at a barrier), not mocked timing.
- `feedback_verify_git_state_before_claiming` — PR only after adversarial review + green tests; Josh merges, codexer never pushes main.

## Out of scope
- Cluster A6 (oauth/enable-agent RMW) — separate follow-on, depends on this landing.
- Any non-lock file.
