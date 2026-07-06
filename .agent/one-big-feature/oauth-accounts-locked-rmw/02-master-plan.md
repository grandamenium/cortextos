# OBF Master Plan — oauth-accounts-locked-rmw (Fable cluster C7)

**Framework:** one-big-feature
**Repo:** /Users/joshweiss/code/cortextos
**Slug:** oauth-accounts-locked-rmw
**Author:** larry
**Date:** 2026-07-06

## Problem (1 HIGH)

`src/bus/oauth.ts` mutates `state/oauth/accounts.json` via **unlocked** read-modify-write in
multiple functions. `saveAccounts` is *atomic* (temp+rename) but atomicity ≠ mutual exclusion:
each writer does `loadAccounts()` (snapshot) → mutate → `saveAccounts(whole store)`.

**The dangerous race (Fable finding, oauth.ts:258-264):** `checkUsageApi` reads the store, sets
`five_hour_utilization` / `seven_day_utilization`, and writes the **whole store** back. If
`refreshOAuthToken` rotates the account's `refresh_token` in that window, `checkUsageApi`'s save
overwrites the freshly-rotated token with the **stale, already-consumed** one from its snapshot.
Refresh tokens are **one-time use** → the consumed token is dead → OAuth auth is permanently broken
until a manual re-auth. This is the exact class that silently knocks accounts offline.

Same unlocked-RMW shape exists in `refreshOAuthToken` (the token write itself) and `rotateOAuth`
(phase-1 accounts.json write). For the fix to actually serialize, **all** accounts.json writers must
share one lock.

## Fix — one shared locked read-modify-write helper, reload inside the lock

- Add `mutateAccounts(ctxRoot, mutator: (store: AccountsStore) => void): AccountsStore | null` to
  `src/bus/oauth.ts`. It runs `withFileLockSync(oauthDir(ctxRoot), () => { const store =
  loadAccounts(ctxRoot); if (!store) return null; mutator(store); saveAccounts(ctxRoot, store);
  return store; })`. Critically it **re-loads inside the lock** so it never writes a stale snapshot.
- Replace every `loadAccounts → mutate → saveAccounts` write path with `mutateAccounts`:
  - `checkUsageApi` (the util-field update at ~258-264) — mutate util fields on the reloaded store.
  - `refreshOAuthToken` — do the network fetch OUTSIDE the lock (withFileLockSync is sync), then
    under `mutateAccounts` set `access_token`/`refresh_token`/`expires_at`/`last_refreshed` on the
    **reloaded** account so a concurrent util write can't clobber the new token.
  - `rotateOAuth` phase-1 accounts.json write — same helper (reload inside lock).
- `withFileLockSync` already uses `hrtime` (fake-timer safe) and the hardened lock primitive from
  PR #74. Use the oauth dir as the lock dir so all three functions serialize on one mutex.

**Out of scope:** rotateOAuth phase-2 `.env` writes (separate concern), any behavior change beyond
serialization + reload-inside-lock. The token/util *semantics* are unchanged — only the RMW is now
atomic-and-mutually-exclusive.

## Proof (fail-first, mandatory)

Concurrency test: run a `checkUsageApi`-style util-write concurrently with a `refreshOAuthToken`-style
token rotation against a seeded accounts.json, then assert the final `refresh_token` equals the
**rotated** value (never the pre-rotation one). On clean main (unlocked) the util-write clobbers the
rotated token → the assertion FAILS. On the branch (locked, reload-inside-lock) the rotated token
survives → PASS. Use forked workers or a controlled interleaving, mirroring
`tests/unit/utils/lock.test.ts`.

## Scope (exact files)
- `src/bus/oauth.ts` (add `mutateAccounts`; convert checkUsageApi / refreshOAuthToken / rotateOAuth
  phase-1 writes to it)
- `tests/unit/bus/oauth-accounts-lock.test.ts` (new — the clobber fail-first)

## Constraints
- TypeScript strict, no `any`, no `console.log`.
- `npm run build` clean; new test FAILS on clean main, PASSES on branch.
- No network calls in tests (stub/inject the fetch or test the write path directly).
- Do not change token/util semantics, env-file writes, or public signatures beyond the new helper.

## Lessons Consulted
- `feedback_agents_claim_live_without_verifying_deploy` — prove with the clobber fail-first test, not a claim.
- `feedback_fix_once_dont_narrate_recurring_bugs` — fix the RMW class once with a shared helper, not one function; all accounts.json writers must share the lock or the fix is illusory.
- SCOPE_LOCK (CLAUDE.md) — spec written from reading real origin/main source (oauth.ts:113-130 load/save, 256-264 checkUsageApi, 273-323 refreshOAuthToken, 336-391 rotateOAuth; lock.ts withFileLockSync), not the dirty working tree.
- `feedback_verify_git_state_before_claiming` — PR only after adversarial review + green tests on the branch; Josh merges.
- PR #74 (lock TOCTOU) — withFileLockSync now rides the hardened lock primitive; reuse it, don't hand-roll a new lock.
