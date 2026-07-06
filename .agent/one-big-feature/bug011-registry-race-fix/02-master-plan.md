# OBF Master Plan — BUG-011 registry-race durable fix

**Slug:** bug011-registry-race-fix
**Repo:** /Users/joshweiss/code/cortextos
**Target file:** `src/daemon/agent-manager.ts` (+ new unit test)
**Owner:** larry (spec) → codexer (impl) → larry (review) → PR (Josh merges)

## Problem (proven from live daemon log, not inference)
Daemon logged: `BUG-011 REGRESSION CHECK: <agent> still in registry during startAgent — pendingRestarts queueing engaged` and `pendingRestarts fired for <agent> — race condition leaked through`. Symptom: an agent whose PTY process died abnormally keeps a **dead-but-registered** entry; a subsequent `startAgent` sees `this.agents.has(name) === true`, defers to `pendingRestarts`, and returns without starting. The `pendingRestarts` drainer runs ONLY inside `stopAgent()` (line ~1032) — and nothing calls `stopAgent` for an already-dead process — so the queued restart is **stranded** and the agent never respawns (phantom lock). codexer + sage were silent-dropped this way.

## Root cause (exact)
`reconcileDeadRegistryEntry(name)` (agent-manager.ts:278) is meant to delete a dead phantom entry so the start can proceed. Its liveness guard is:
```
const pid = entry.process.getStatus().pid;
if (!pid || this.isPidAlive(pid)) return false;   // BUG: falsy pid => "keep entry"
```
A phantom entry whose process reports **no pid** (`!pid`) is exactly a dead-but-registered entry, but the `!pid` short-circuit returns `false` (do-not-reconcile), leaving the stale entry in `this.agents`. `startAgent` then defers to `pendingRestarts` and strands.

## Fix (minimal, single-site + safety net)
1. **`reconcileDeadRegistryEntry`**: treat a falsy pid as DEAD, not alive. Reconcile (delete entry + stop pollers/checker/scheduler + clear pendingRestarts) when `!pid || !isPidAlive(pid)`. Only a genuinely **live** pid may keep the entry. Preserve all existing cleanup side-effects.
2. **`startAgent` anti-strand guard**: after `reconcileDeadRegistryEntry(name)` at line 385, if `this.agents.has(name)` is still true AND the registered entry's process is not alive, force-reconcile once more and proceed to a fresh start instead of deferring to `pendingRestarts`. `pendingRestarts` deferral must remain ONLY for a genuinely-alive in-flight start collision (true dedup), never for a dead entry.

## Non-goals / scope guard
- Do NOT alter the legitimate in-flight stop/start dedup (genuinely-alive entry → defer is correct).
- Do NOT touch the atomic-state-layer writers (already fixed, PR #71) — different bug-class, different files.
- Single file + one new test. No schema, no multi-repo, no new subsystem → OBF (not M2C1).

## Verification (required in handoff)
- New unit test in `tests/unit/daemon/agent-manager.test.ts` (or existing daemon test file) that: constructs a registry entry whose `process.getStatus().pid` is falsy/dead, calls `startAgent`, and asserts the phantom is reconciled and a fresh process start is attempted (NOT added to `pendingRestarts`). Test must FAIL on clean base and PASS after the fix.
- `npm run build` clean.
- `npx vitest run tests/unit/daemon/` green; note any pre-existing failures reproduced on clean base.
- No `any`, no `console.log` added (existing `console.warn`/`console.log` diagnostics may stay/extend).

## Lessons Consulted
- `feedback_agents_claim_live_without_verifying_deploy` — prove the fix with a failing→passing test, not a claim.
- `feedback_fix_once_dont_narrate_recurring_bugs` — BUG-011 has regressed repeatedly; this is the durable single-site cure, not another band-aid.
- SCOPE_LOCK (CLAUDE.md) — spec written from reading the real source (agent-manager.ts:278-298, 384-414, 1007-1044), not a summary; scope = 1 file + 1 test, enumerated.
- `feedback_verify_git_state_before_claiming` — PR only after adversarial review + green tests; Josh merges.
