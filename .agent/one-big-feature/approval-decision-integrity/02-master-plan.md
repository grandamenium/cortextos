# OBF Master Plan — approval-decision-integrity (Fable cluster C3)

**Framework:** one-big-feature
**Repo:** /Users/joshweiss/code/cortextos
**Slug:** approval-decision-integrity
**Author:** larry
**Date:** 2026-07-06

## Problem (2 HIGH, security)

The Telegram approval/plan-review gate can silently flip a user **DENY into ALLOW**.

Root cause chain:
1. **Writer (non-atomic):** `src/daemon/fast-checker.ts:787` writes the decision file with a raw
   `writeFileSync(responseFile, JSON.stringify({decision}) + '\n', 'utf-8')`. Not atomic — a reader
   polling via `fs.watch`/interval (`src/hooks/index.ts:140-151 waitForResponseFile`) can observe a
   **torn or empty** file mid-write. The restart-response writer at `:805` has the same defect.
2. **Consumer (fails open):** `src/hooks/hook-planmode-telegram.ts:117-128` does `JSON.parse(content)`
   and on failure `outputDecision('allow')`. So a torn/empty decision file — produced when a real user
   tapped **Deny Plan** — parses-fails and becomes **ALLOW**.

Why it matters: both the permission hook and the plan-review hook route their Telegram callbacks
through the *same* `perm_(allow|deny|continue)_<hexId>` handler (`buildPlanKeyboard` emits
`perm_allow_${uniqueId}` / `perm_deny_${uniqueId}`), so the single write at fast-checker.ts:787 backs
both gates. The permission hook is already **fail-closed** (parse-fail → deny, "Invalid response
file"). The plan-review hook is **fail-open** — the inconsistency is the bug. This gate is what
protects main-merges and prod ops from unapproved plans.

## Fix (root cause + defense-in-depth, no behavior regression on genuine timeout)

- **A — Atomic writer (root cause):** In `src/daemon/fast-checker.ts`, replace the raw
  `writeFileSync` at `:787` (perm/plan response) and `:805` (restart response) with the existing
  `atomicWriteSync` (`src/utils/atomic.ts`, temp-file + rename → readers only ever see no-file or a
  complete file). `atomicWriteSync` appends its own `\n`, so pass the JSON without the manual `+ '\n'`.
- **B — Fail-closed consumer (defense):** In `src/hooks/hook-planmode-telegram.ts`, the JSON.parse
  catch at `:127-128` must **deny**, not allow: `outputDecision('deny', 'Plan approval response was
  unreadable — denying for safety. Re-plan.')`. This aligns plan-review with the permission hook's
  already-correct "Invalid response file → deny".

**Explicitly preserve** the deliberate anti-wedge fail-open on **genuine timeout** (`content === null`,
no decision ever made) and on **send failure** — those are NOT the reported bug and changing them
would wedge every agent during a Telegram outage. Scope is strictly: torn/empty/corrupt *present*
decision file → must never become ALLOW.

## Proof (fail-first, mandatory)

Unit test on the plan-review decision logic:
- valid `{decision:"allow"}` → allow
- valid `{decision:"deny"}` → deny
- **corrupt / empty present file → deny** ← fails on main (emits allow), passes on branch
- no file / timeout → allow (unchanged — guards against a regression of the anti-wedge intent)

The corrupt-file case is the fail-first: it must FAIL on clean main and PASS on the branch.

## Scope (exact files)
- `src/daemon/fast-checker.ts` (lines 787, 805 — atomic writes)
- `src/hooks/hook-planmode-telegram.ts` (lines 127-128 — fail closed on parse failure)
- `tests/unit/hooks/hook-planmode-telegram.test.ts` (new — decision-logic table incl. fail-first)

Out of scope (separate clusters): permission-hook (already fail-closed), the generic
`waitForResponseFile` reader, timeout/send-fail fail-open semantics, atomicWriteSync fsync (C6).

## Constraints
- TypeScript strict, no `any`, no `console.log`.
- `npm run build` clean, `npm test` green.
- No change to permission-hook or timeout behavior.

## Lessons Consulted
- `feedback_agents_claim_live_without_verifying_deploy` — prove the fix with a failing→passing test (the corrupt-file fail-first), never a bare claim.
- `feedback_fix_once_dont_narrate_recurring_bugs` — fix the root cause (non-atomic writer) once, not just the visible symptom; the fail-open consumer is defense-in-depth on top.
- SCOPE_LOCK (CLAUDE.md) — spec written from reading the real source (fast-checker.ts:782-807, hook-planmode-telegram.ts:106-142, hooks/index.ts:140-151, index.ts:335 buildPlanKeyboard, atomic.ts:14-42), not a summary; scope enumerated as exactly 3 files.
- `feedback_verify_git_state_before_claiming` — PR only after adversarial review + green tests verified on the branch; Josh merges to main.
- Website/state accuracy discipline — the permission hook is already fail-closed (verified by reading it), so the inconsistency (planmode fail-open) is the real bug, not a blanket "make everything deny".
