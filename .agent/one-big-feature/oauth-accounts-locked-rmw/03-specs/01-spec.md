# Spec 01 — oauth-accounts-locked-rmw (C7)

## Josh's exact request (verbatim)
"Fix them" — the 70 verified Fable-hunt bugs. This is cluster C7 (1 HIGH):
`checkUsageApi` unlocked RMW on accounts.json can overwrite a freshly-rotated ONE-TIME refresh token
with the consumed one → OAuth auth permanently broken until manual re-auth.

## Root cause (verified on origin/main)
`src/bus/oauth.ts`: `saveAccounts` is atomic but there is NO lock. `checkUsageApi` (~258-264),
`refreshOAuthToken` (~316-322), and `rotateOAuth` (phase-1) each do
`loadAccounts()` → mutate → `saveAccounts(whole store)`. A util-field write in `checkUsageApi` based
on a stale snapshot clobbers a `refresh_token` that `refreshOAuthToken` rotated in the meantime.

## Change 1 — shared locked-RMW helper
**File:** `src/bus/oauth.ts`

Add (near loadAccounts/saveAccounts), importing `withFileLockSync` from `../utils/lock`:
```ts
/**
 * Locked read-modify-write of accounts.json. Reloads INSIDE the lock so a
 * concurrent writer (e.g. a token rotation) is never clobbered by a stale
 * snapshot. Returns the saved store, or null if accounts.json is absent.
 */
export function mutateAccounts(
  ctxRoot: string,
  mutator: (store: AccountsStore) => void,
): AccountsStore | null {
  return withFileLockSync(oauthDir(ctxRoot), () => {
    const store = loadAccounts(ctxRoot);
    if (!store) return null;
    mutator(store);
    saveAccounts(ctxRoot, store);
    return store;
  });
}
```

## Change 2 — checkUsageApi uses the helper
Replace the unlocked block (~258-264):
```ts
const store = loadAccounts(ctxRoot);
if (store && store.accounts[accountName]) {
  store.accounts[accountName].five_hour_utilization = fiveHour;
  store.accounts[accountName].seven_day_utilization = sevenDay;
  saveAccounts(ctxRoot, store);
}
```
with:
```ts
mutateAccounts(ctxRoot, (store) => {
  const acct = store.accounts[accountName];
  if (acct) {
    acct.five_hour_utilization = fiveHour;
    acct.seven_day_utilization = sevenDay;
  }
});
```
(The mutator runs on the store reloaded inside the lock — so it preserves any refresh_token rotated
by a concurrent refresh.)

## Change 3 — refreshOAuthToken writes the rotated token under the lock
Keep the `fetch(...)` OUTSIDE the lock. Replace the final unlocked write (~316-322):
```ts
store.accounts[name] = { ...account, access_token: ..., refresh_token: ..., expires_at, last_refreshed: ... };
saveAccounts(ctxRoot, store);
```
with a reload-inside-lock write:
```ts
mutateAccounts(ctxRoot, (s) => {
  const prev = s.accounts[name];
  if (!prev) throw new Error(`Account "${name}" vanished during refresh`);
  s.accounts[name] = {
    ...prev,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    last_refreshed: new Date().toISOString(),
  };
});
```
Preserve the `CRITICAL: writes accounts.json ... BEFORE returning` intent — the write still completes
before the function returns.

## Change 4 — rotateOAuth phase-1 write
Convert rotateOAuth's phase-1 accounts.json read-modify-write (the `store.active = ...` /
rotation_log update that ends in `saveAccounts`) to `mutateAccounts` the same way (reload inside
lock, mutate the reloaded store). Do NOT touch phase-2 `.env` writes or the rotation decision logic.
If rotateOAuth calls `refreshOAuthToken` internally, leave that call as-is (it now locks itself).

## Change 5 — new test (MANDATORY fail-first)
**File:** `tests/unit/bus/oauth-accounts-lock.test.ts`

Seed a temp accounts.json with an account holding `refresh_token: "OLD"`. Concurrently:
(a) a util-write path (like checkUsageApi's mutate: reload snapshot, set utilization, save) and
(b) a token rotation (mutateAccounts setting `refresh_token: "NEW"`).
Assert the final on-disk `refresh_token === "NEW"` (rotation never lost).

To make the race deterministic and prove the fix: model writer (a) as the *unlocked* stale-snapshot
RMW for the fail-first (it must clobber NEW→OLD on main semantics), and as `mutateAccounts` on the
branch. Simplest robust form mirrors `tests/unit/utils/lock.test.ts`: forked workers doing the two
RMWs against the same file across several rounds; assert zero rounds end with the token reverted.
The test MUST FAIL on clean main (unlocked checkUsageApi clobbers the token) and PASS on the branch.

## Acceptance
- `npm run build` clean; `npm test` green (aside from the known pre-existing hooks.test.ts symlink
  failure, which is unrelated).
- New test FAILS on clean main, PASSES on branch.
- No `any`, no `console.log`. No network in tests. Diff limited to `src/bus/oauth.ts` + the new test.
- Token/util semantics, public signatures (except new `mutateAccounts`), and env writes unchanged.
