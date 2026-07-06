# Spec 01 — Lock + Atomic + Bak on all shared-state writers

**Owner:** codexer (production `.ts` in src/). Larry reviews.
**Standard to copy:** `src/bus/crons.ts` `writeCrons` (line ~205) — `withFileLockSync(dir, () => atomicWriteSync(path, data, { keepBak: true }))`. Helpers: `src/utils/atomic.ts` (`atomicWriteSync`), the lock helper crons.ts already imports (`withFileLockSync`). Reuse them; add NO new deps or modules.

## Reproducing test FIRST (write these before touching the writers)
Add `tests/unit/bus/state-atomicity.test.ts`:
1. **Lost-update:** spawn 2 concurrent `updateTask` calls on the same task id changing different fields; assert BOTH mutations survive (no last-write-wins clobber). Today: fails.
2. **Torn-read → no reset:** simulate a partial-file read of `cron-state.json` / `pending-reminders.json` (write a truncated file, then call the reader); assert the reader does NOT silently return empty and does NOT overwrite good state (or that a `.bak` restores it). Today: fails.
3. **Dedup TOCTOU:** two concurrent `checkAndRecord` for the same key; assert exactly one records and the ledger keeps the entry. Today: fails.
Each test must FAIL on current main (proving the bug is real), then PASS after the fix.

## Changes (each = wrap read-modify-write in lock, write via atomicWriteSync keepBak)
Apply to every writer in 02-master-plan §In scope. Specifics that differ from a plain wrap:
- `bus/task.ts archiveTasks`: do NOT write-in-place-then-rename. Write the archived payload directly to the archive path (`atomicWriteSync`) then `unlinkSync` the source — copy `compactTasks` (874-875). Eliminates the torn active/archived window.
- `bus/task.ts createTask` peer edges: hold ONE lock on `taskDir` across all `addSymmetricEdge` calls so two concurrent creates declaring the same peer don't clobber the peer's `blocks[]`.
- `bus/message.ts ackInbox`: acquire the inbox lock (or a dedicated inflight lock) BEFORE `readdirSync(inflight)` + rename, so it can't race `recoverStaleInflight` re-queuing the same file (which today silently drops the message).
- `telegram/dedup.ts checkAndRecord`: it's synchronous — guard the read-check-write with an O_EXCL sentinel or a `withFileLockSync` on the ledger dir.

## Constraints (hook-enforced)
- No `any`, no `console.log` (use existing logging), TypeScript strict, atomic writes only.
- Behavior-preserving: same public function signatures, same return shapes. Pure durability change.
- Every touched writer keeps a `.bak` on write (keepBak: true) so a torn write is recoverable.

## Acceptance
- [ ] `tests/unit/bus/state-atomicity.test.ts` fails on main, passes after.
- [ ] `grep -rn "writeFileSync" src/bus src/telegram/dedup.ts src/hooks/hook-loop-detector.ts` shows no bare writes on shared state (only atomic wrappers).
- [ ] `npm run build` clean, `npm test` green.
- [ ] Larry adversarial review: scope match vs the 8 writers, no logic drift, tests reproduce then fix. → PR. Josh gates merge.
