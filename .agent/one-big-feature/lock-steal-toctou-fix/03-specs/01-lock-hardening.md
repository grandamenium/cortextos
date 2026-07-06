# Spec 01 — Harden src/utils/lock.ts (atomic steal + owned release + crash recovery)

**File to edit:** `src/utils/lock.ts` (144 lines currently)
**Test file:** `tests/unit/utils/lock.test.ts` (create if absent; else extend)

## Verbatim scope — 3 defects, all in src/utils/lock.ts
1. steal-TOCTOU in the stale-recovery block (current lines ~56-66).
2. releaseLock unconditional delete (current lines ~73-80).
3. crash-mid-acquire / corrupt-pid never-reclaimed (current lines ~33-48).

## Required changes

### 1. Atomic stale-steal (replace rmSync+mkdir with rename-claim)
Current stale branch:
```ts
} catch {
  // Process is dead - stale lock, remove and re-acquire atomically.
  try {
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch { return false; }
}
```
Replace the steal with an atomic rename-claim:
- Build a unique claim path: `join(dir, \`.lock.d.claim.${process.pid}.${nextClaimSeq()}\`)` where `nextClaimSeq`
  is a module-scoped incrementing integer (NO Date.now/Math.random — those are banned in this codebase per
  build rules; a monotonic counter is deterministic and sufficient for intra-process uniqueness, and
  process.pid disambiguates across processes).
- `renameSync(lockDir, claimPath)` inside try/catch. On throw (ENOENT — another stealer already renamed it, or
  the holder released) → `return false` (lost the steal; caller retries).
- On success (we own the claim): `rmSync(claimPath, { recursive: true, force: true })`, then
  `mkdirSync(lockDir)`. If `mkdirSync` throws `EEXIST`, a fresh acquirer legitimately took the now-empty slot
  first → `return false`. Otherwise `writeFileSync(pidFile, String(process.pid))` and `return true`.

### 2. Ownership-checked release
Replace `releaseLock` body:
```ts
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const owner = parseInt(raw, 10);
    // Only the owning process (or a dead/corrupt owner) may clear the lock.
    if (!isNaN(owner) && owner !== process.pid && isPidAlive(owner)) return; // not ours + live → leave it
  } catch { /* no/corrupt pid file — safe to clear */ }
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
```
Add a small local `isPidAlive(pid: number): boolean` helper (try `process.kill(pid, 0)` → true; catch → false)
or reuse an existing one if present in the module. No `any`.

### 3. Bounded recovery for missing / corrupt pid (crash-mid-acquire)
In the EEXIST contention path, when the pid file is missing OR parses to NaN/empty:
- `statSync(lockDir).mtimeMs` (via hrtime-independent fs stat) to measure lock-dir age. Use a GRACE constant
  (module const, e.g. `const STALE_PID_GRACE_MS = 500`).
- If age < grace → `return false` (genuine mid-acquire holder; retry).
- If age ≥ grace → treat as stale; steal via the SAME atomic rename-claim path as defect #1.
- Keep: a live valid pid still returns false (unchanged).

## Test requirements (test-first — each MUST fail on current lock.ts, pass after)
Create `tests/unit/utils/lock.test.ts`. Use real concurrency, not mocks, for the race proofs. Prefer
`node:worker_threads` (N workers) or spawned child processes hitting a shared tmp dir via a barrier
(all start acquiring within the same tick). Record every acquire that returned true with a timestamp/hold
window; assert **no two hold windows overlap**.

Required cases:
- **T1 exactly-one-holder under contention:** N=8 contenders race `withFileLockSync` on one dir doing a
  read-modify-write of a counter; assert final counter === N (no lost updates) AND no overlapping holds.
- **T2 stale dead-pid steal is atomic:** pre-seed `.lock.d/pid` with a guaranteed-dead pid; N=4 contenders
  steal simultaneously; assert exactly one acquires at a time (never two holders). This is the TOCTOU repro.
- **T3 crash-mid-acquire recovery:** pre-seed `.lock.d` with NO pid file, mtime older than grace; assert a
  contender recovers (acquires) rather than spinning to timeout. Also a fresh (< grace) empty lock dir →
  contender returns false / retries (does NOT steal a real mid-acquire).
- **T4 release ownership:** process A holds; simulate a foreign pid in the pid file; assert `releaseLock`
  called by the non-owner does NOT delete a live owner's dir.
- Keep all existing lock tests green.

## Constraints
- TypeScript strict, no `any`, no `console.log` (module already uses none — keep it that way).
- No new runtime deps.
- Do not change `withFileLockSync`'s public signature, backoff, or timeout semantics.
- Return the full diff + which tests were added and their fail-on-clean / pass-after evidence.
