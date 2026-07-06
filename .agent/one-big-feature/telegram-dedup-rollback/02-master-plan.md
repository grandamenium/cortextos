# OBF Master Plan — telegram-dedup-rollback (Fable cluster C1, narrowed)

**Framework:** one-big-feature
**Repo:** /Users/joshweiss/code/cortextos
**Slug:** telegram-dedup-rollback
**Author:** larry
**Date:** 2026-07-06

## Problem (1 HIGH)

`send-telegram` records the dedup entry **before** the message is actually sent, with **no
rollback** on failure. `checkAndRecord` (`src/telegram/dedup.ts`) writes `ledger[key] = now` and is
called in `src/cli/bus.ts` *before* `api.sendMessage(...)`. If the send then fails (network, 429,
Telegram error), the dedup entry persists → **every retry of that exact message is suppressed for the
full dedup window (default 21600s / 6h)**. A failed critical alert silently never re-sends.

**Already fixed on origin/main (verified — NOT in scope):** the "unlocked cross-process RMW on
telegram-dedup.json" half of the Fable finding. `checkAndRecord` already wraps its
read→prune→check→write in `withFileLockSync(dedupLockDir, ...)` and reads the ledger inside the lock.
Only the record-before-send / no-rollback defect remains.

## Fix — locked rollback on send failure (preserve the anti-concurrent-dupe guarantee)

Keep record-before-send (it prevents two concurrent sends from both firing), but undo it when the
send fails:
- Add `removeRecord(ctxRoot, chatId, body): void` to `src/telegram/dedup.ts` — under the SAME
  `withFileLockSync(dedupLockDir, ...)`, load the ledger, delete `dedupKey(chatId, body)`, write back
  with `atomicWriteSync`. Mirror `checkAndRecord`'s lock + atomic-write pattern exactly.
- In `src/cli/bus.ts`, track whether this call recorded an entry (`dedupEnabled && !duplicate`). In
  the send-failure path (the `catch` around `api.sendMessage` / the streaming+media send), call
  `removeRecord(...)` before the non-zero exit / rethrow, so a retry is not suppressed. Do NOT roll
  back on a claim-gate HOLD (exit 2) — that is an intentional block, not a failed send, and the
  message was never recorded past the gate anyway (gate runs after dedup; if held, leaving the record
  is acceptable but preferably also rolled back — see spec for exact placement).

## Proof (fail-first, mandatory)

Unit test at the dedup layer modeling record → send-fails → retry:
`checkAndRecord` (records, returns not-duplicate) → simulate send failure via `removeRecord` →
`checkAndRecord` again must return `{duplicate:false}` (retry allowed). On clean main there is no
`removeRecord`, so the second `checkAndRecord` returns `{duplicate:true}` (suppressed) — the test
FAILS. On the branch it PASSES. Plus a guard test: without a failure, a genuine duplicate within the
window is still suppressed (no behavior regression).

## Scope (exact files)
- `src/telegram/dedup.ts` (add `removeRecord`)
- `src/cli/bus.ts` (roll back on send failure)
- `tests/unit/telegram/dedup-rollback.test.ts` (new — fail-first + no-regression guard)

Out of scope (separate cluster C1b): per-chunk rate limiting (`api.ts:205-221`), unimplemented
`onParseFallback` (`api.ts:198`), poller ack-before-process (`poller.ts`).

## Constraints
- TypeScript strict, no `any`, no `console.log` (existing `console.log`/`console.error` in bus.ts
  send path are pre-existing CLI output — do not add new ones; match surrounding style).
- `npm run build` clean; new test FAILS on clean main, PASSES on branch.
- No change to the dedup window, key derivation, or the locked-RMW already present.

## Lessons Consulted
- `feedback_agents_claim_live_without_verifying_deploy` — prove with the record→fail→retry fail-first, not a claim.
- `feedback_fix_once_dont_narrate_recurring_bugs` — fix the root (rollback on failure) once; reuse the existing lock, don't hand-roll.
- SCOPE_LOCK (CLAUDE.md) — spec from reading real origin/main source (dedup.ts full file, cli/bus.ts 1132-1235); discovered the unlocked-RMW half was ALREADY fixed, so scope narrowed to rollback only — enumerated, not the whole finding.
- `feedback_verify_git_state_before_claiming` — PR after adversarial review + green tests on branch; Josh merges.
- The dedup module is what I depend on to reach Josh — a failed send that self-suppresses for 6h is exactly the silent-drop class the fleet keeps hitting.
