# OBF Spec 01 — telegram-dedup-rollback (Fable cluster C1, narrowed)

**Slug:** telegram-dedup-rollback
**Repo:** /Users/joshweiss/code/cortextos
**Base:** origin/main (014f5f8 or later) — **NOT the local working tree** (local main is a stale
snapshot `61d7c58` that predates the dedup lock; verify everything with `git show origin/main:<path>`).
**Author:** larry · **Date:** 2026-07-06

---

## The defect (1 HIGH)

`send-telegram` records the dedup ledger entry **before** the message is actually sent, and never
rolls it back on failure.

Verified on **origin/main**:
- `src/telegram/dedup.ts` — `checkAndRecord` is already correctly locked (`withFileLockSync(dedupLockDir, …)`,
  reads the ledger inside the lock, `atomicWriteSync(..., /* keepBak */ true)`). **That half of the
  Fable finding is already fixed — DO NOT touch the locking or the RMW.**
- `src/cli/bus.ts` `send-telegram` handler:
  - line ~1137: `const { duplicate, ageSec } = checkAndRecord(env.ctxRoot!, chatId, message, windowSec);`
    → records `ledger[key] = now` **before** the send.
  - line ~1213: claim-gate HOLD → `process.exit(2)` (after the record, message never sent).
  - line ~1270: `api.sendMessage(...)` inside `try`.
  - line ~1326-1329: `catch (err: any) { console.error(...); process.exit(1); }` — the send-failure
    path, **no rollback**.

**Impact:** if the send fails (network / 429 / Telegram error) the ledger entry persists, so **every
retry of that exact message is suppressed for the full dedup window (default 21600s / 6h)**. A failed
critical alert silently never re-sends. This is the silent-drop class the fleet keeps hitting on the
one channel we depend on to reach Josh.

---

## The fix — locked rollback on any non-sent exit (keep the concurrent-dupe guarantee)

Keep record-before-send (it still prevents two concurrent identical sends from both firing). Undo the
record on any path that exits **without** a successful send.

### 1. `src/telegram/dedup.ts` — add `removeRecord`

Add an exported `removeRecord` that mirrors `checkAndRecord`'s lock + atomic-write pattern **exactly**:

```ts
export function removeRecord(ctxRoot: string, chatId: string, body: string): void {
  const ledgerPath = join(ctxRoot, 'state', 'telegram-dedup.json');
  const lockDir = dedupLockDir(ctxRoot);
  const key = dedupKey(chatId, body);
  ensureDir(dirname(ledgerPath));
  ensureDir(lockDir);

  withFileLockSync(lockDir, () => {
    const ledger = readLedger(ledgerPath);
    if (ledger[key] === undefined) return;   // nothing to roll back
    delete ledger[key];
    atomicWriteSync(ledgerPath, JSON.stringify(ledger, null, 2), /* keepBak= */ true);
  });
}
```

- Same `dedupLockDir(ctxRoot)`, same `readLedger`, same `atomicWriteSync(..., true)` keepBak flag as
  `checkAndRecord`. Do **not** prune here (rollback is targeted; pruning is `checkAndRecord`'s job).
- No new imports beyond what dedup.ts already imports. No `any`, no `console.*`.

### 2. `src/cli/bus.ts` — roll back on the two non-sent exit paths

- Track whether **this** invocation recorded an entry. In the `dedupEnabled` block, after a
  non-duplicate `checkAndRecord`, set a `let recordedDedup = false;` (declared just before the
  `dedupEnabled` block) to `true`. (It stays `false` when dedup is disabled or the message was a
  duplicate — in the duplicate case we `return` early and never reach the send anyway.)
- Import `removeRecord` alongside the existing `checkAndRecord` import (line ~36).
- **Send-failure path (line ~1326 catch):** before `process.exit(1)`, if `recordedDedup` and
  `env.ctxRoot`, call `removeRecord(env.ctxRoot, chatId, message)`. Wrap the rollback in its own
  `try { … } catch { /* non-fatal: rollback best-effort */ }` so a rollback failure never masks the
  original send error. Keep the existing `console.error('Failed to send: …')` and `process.exit(1)`.
- **Claim-gate HOLD path (line ~1213, `process.exit(2)`):** before `process.exit(2)`, same guarded
  `removeRecord(...)` call. Rationale: the gate — not a stale 6h dedup entry — must be the thing that
  blocks; leaving the record would suppress a legitimate re-send (after the claim is verified) with a
  misleading "duplicate" reason. Roll back so dedup semantics stay pure.

  ⚠️ Placement note: the gate block reads `message` and may reassign nothing before exit; use the same
  `chatId` / `message` in scope at that point. The gate HOLD is inside the `if (decision.action === 'hold')`
  branch — put the rollback immediately before `process.exit(2)`, after the existing `logEvent` +
  `process.stderr.write`.

- Do **not** roll back on the streaming path (streaming never sets `dedupEnabled`, so `recordedDedup`
  is already `false` there — no special-casing needed).
- Do **not** add new `console.log`/`console.error` beyond the existing ones; match surrounding style.
  The existing `catch (err: any)` type is pre-existing — leave it; do not introduce any **new** `any`.

---

## Proof (fail-first, mandatory)

New test `tests/unit/telegram/dedup-rollback.test.ts` (dedup-layer, no network, tmp ctxRoot):

1. **Fail-first (the fix):** `checkAndRecord(ctx, chat, body, W)` → returns `{duplicate:false}`
   (records). Simulate a failed send by calling `removeRecord(ctx, chat, body)`. Call
   `checkAndRecord(ctx, chat, body, W)` again → **must** return `{duplicate:false}` (retry allowed).
   On clean origin/main there is no `removeRecord` export → the test cannot even import it / the retry
   stays suppressed → **FAILS**. On the branch → **PASSES**.
2. **No-regression guard:** without any `removeRecord`, two `checkAndRecord` calls with the same
   (chat, body) inside the window → second returns `{duplicate:true}` (still suppressed). Proves the
   rollback did not weaken normal dedup.
3. **Targeted:** `removeRecord` for (chatA, body) must NOT delete a recorded (chatB, body) entry —
   assert the other key survives.

Use a real temp dir via `mkdtempSync(os.tmpdir())` for `ctxRoot`; clean up after. Mirror the style of
existing `tests/unit/telegram/*.test.ts`. Fake timers only if needed for window math (checkAndRecord
uses `Date.now()`); prefer a large window so no timer control is required.

---

## Scope (exact files — nothing else)
- `src/telegram/dedup.ts` — add `removeRecord` (and only that).
- `src/cli/bus.ts` — import `removeRecord`; add `recordedDedup` flag; guarded rollback on the exit-1
  catch and the exit-2 gate HOLD.
- `tests/unit/telegram/dedup-rollback.test.ts` — new (fail-first + no-regression + targeted).

## Out of scope (separate cluster C1b — do NOT touch)
- Per-chunk rate limiting (`api.ts:205-221`), `onParseFallback` (`api.ts:198`), poller
  ack-before-process (`poller.ts`). Any change to the dedup window, key derivation, or the existing
  `checkAndRecord` lock/RMW.

## Constraints
- TypeScript strict; no new `any`; no new `console.*`.
- `npm run build` clean.
- New test **FAILS on clean origin/main, PASSES on branch** — include both replay outputs in the report.
- Branch: `feat/telegram-dedup-rollback` off origin/main (014f5f8+). Commit; do NOT push or PR (larry
  handles PR after adversarial review).

## Verification handback (what larry re-runs independently)
- `git show <commit> --stat` → scope is exactly the 3 files above.
- Build clean; new test passes on branch; same test fails on clean origin/main (isolated worktree).
- Diff of `bus.ts` shows rollback on BOTH exit paths, each guarded try/catch, no other logic changed.
