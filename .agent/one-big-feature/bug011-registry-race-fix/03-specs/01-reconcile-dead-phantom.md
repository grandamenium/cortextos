# Spec shard 01 — reconcile dead-but-registered phantom + anti-strand guard

**File:** `src/daemon/agent-manager.ts`
**Test:** `tests/unit/daemon/agent-manager.test.ts` (create if absent)

## Change 1 — `reconcileDeadRegistryEntry` (currently line ~278)
Current:
```ts
const pid = entry.process.getStatus().pid;
if (!pid || this.isPidAlive(pid)) return false;
```
Replace the guard so a falsy pid counts as DEAD (reconcile), and only a live pid keeps the entry:
```ts
const pid = entry.process.getStatus().pid;
// A registered entry whose process reports NO pid is a dead-but-registered
// phantom (process died abnormally, registry entry survived) — reconcile it.
// Only a genuinely-alive pid may keep the entry.
if (pid && this.isPidAlive(pid)) return false;
```
Keep every existing side-effect below unchanged (stop poller/activityPoller/checker, `agents.delete`, `pendingRestarts.delete`, scheduler stop) and keep returning `true` after reconciling. Update the warn log to note the phantom case, e.g. include `(pid ${pid ?? 'none'} not alive)`.

## Change 2 — `startAgent` anti-strand guard (currently line ~384-414)
After `this.reconcileDeadRegistryEntry(name);` and before/at the `if (this.agents.has(name))` block: if the entry is STILL present but its process is not alive, force-reconcile once and fall through to a fresh start rather than deferring to `pendingRestarts`. Only defer to `pendingRestarts` when the registered process is genuinely alive (true in-flight-start collision). Concretely, guard the `pendingRestarts.add(name); return;` path so it is taken ONLY for a live process; for a dead entry, delete it and continue to the normal start path. Preserve the `daemonJustCrashed` info-vs-warn logging distinction.

## Test requirements
- Build a manager with an injected/faked agent entry whose `process.getStatus()` returns `{ pid: undefined }` (or a pid that `isPidAlive` reports dead).
- Assert: calling `startAgent(name, dir)` reconciles the phantom (entry removed) and proceeds to spawn a fresh process — `pendingRestarts` does NOT contain `name` afterward.
- Add a companion test proving the legitimate path is preserved: an entry with a genuinely-alive pid → `startAgent` still dedups (defers, no double-spawn).
- Test must FAIL on clean base `origin/main` and PASS after the change.

## Constraints
- No `any`. No new `console.log` (existing warn/log diagnostics may be edited/extended).
- Do not modify unrelated methods. Diff limited to `reconcileDeadRegistryEntry`, the `startAgent` deferral guard, and the new test.
