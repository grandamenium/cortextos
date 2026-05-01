# PR #272 — Pipeline Passed (fix-branch verified, ready for merge)

**Title:** feat(bus): hooks framework — Day-1 stub + Day-2 per-handler wiring + telemetry
**Author:** noogalabs (commit attribution: collie via dane dispatch)
**Head branch:** feat/bus-hooks-framework
**Final commit reviewed:** 6f5c70a (boris co-author fix on top of b647f46)
**Diff:** +630 / -1, 2 files (`src/bus/hooks.ts` 343 lines + 1-line spread fix; `tests/unit/bus/hooks.test.ts` 257+30 lines)
**Risk tier:** LOW
**Iterations:** 2 (initial review, then re-verify after fix)
**Duration:** ~15 min

## What was tested

**Stage 1 — Static gates (all pass)**

| Gate | Result |
|---|---|
| package.json unchanged → no new external deps | PASS |
| No hardcoded secrets in diff | PASS |
| `npm run build` against pr-272-test | PASS (33ms) |
| `npx vitest run` full suite | PASS — 726/726, including 18 new hook tests |
| `tsc --noEmit` | PASS — clean |

**Stage 2 — Importer scan**
- `grep -rn 'bus/hooks'` confirms zero imports of the new module outside its own test file. The module is dead code in this PR — Day-3 follow-up will wire callers.

**Stage 4 — Sandbox checks**

- **B4 — emitter CLI shape:** `cortextos bus log-event action hook_fire info --meta '{...}'` accepts the exact argv that `emitHookBusEvent` passes to `execFile`. Event written to disk. PASS.
- **B1+B2 — sandbox build/test parity:** built ~/cortextos-sandbox on pr-272-test, build clean, tests still all green. PASS.
- **B3 (lite) — CLI load:** `node dist/cli.js status --instance pr-sandbox` against sandbox: loaded without import-time errors from the new module. PASS.
- **C1 — dispatcher with `CTX_ROOT` unset:** dispatcher does not throw; `appendActivityLine`'s try/catch absorbs the path error as designed. PASS.
- **C4 — handler meta override of bookkeeping fields:** **CONFIRMED BUG (low severity).** See below.

## What was observed

The 18 unit tests are well-scoped and exercise every documented branch of `dispatchHook`, `loadHookRegistry`, `matchHooks`, and the registry CRUD. Edge cases I went looking for outside the unit-test surface mostly held up:

- Fail-open on missing or malformed `hooks.json` — verified.
- Async handler `await`ing — verified.
- Throw → `hook_block` — verified.
- Backwards-compat empty registry → `{action: 'fire', reason: 'no_handler_registered'}` — verified.

One real bug surfaced in the C-set:

### Bug: handler `meta` can override dispatcher bookkeeping fields

In `src/bus/hooks.ts:266-275`, the dispatcher emits the bus event by spreading `result.meta` AFTER the named bookkeeping fields:

```ts
emitHookBusEvent(eventName, {
  hook_id: hook.id,
  handler_type: hook.handler_type,
  event_id: event.id,
  event_category: event.category,
  event_type: event.event,
  source_agent: event.agent,
  outcome: result.reason ?? `${result.action}_no_reason`,
  ...(result.meta ?? {}),   // ← overrides the named fields above
});
```

But the `HandlerResult` JSDoc (lines 76-79) explicitly claims:

> `meta` is merged into the bus event meta, **never used to override the dispatcher's own bookkeeping fields.**

I confirmed this in the sandbox: a handler that returned `{action:'fire', meta:{hook_id:'OVERRIDE_ATTEMPT', source_agent:'OVERRIDE_ATTEMPT'}}` successfully clobbered both fields in the emitted event payload.

**Severity:** Low. Blast radius is bus telemetry only — no security boundary, no cross-org leak, no agent state mutation. But the code/docstring divergence will mislead any handler author who reads the docstring before reading the spread order.

**One-line fix:**
```ts
emitHookBusEvent(eventName, {
  ...(result.meta ?? {}),   // spread first
  hook_id: hook.id,
  handler_type: hook.handler_type,
  event_id: event.id,
  event_category: event.category,
  event_type: event.event,
  source_agent: event.agent,
  outcome: result.reason ?? `${result.action}_no_reason`,
});
```

Either fix the spread order or update the docstring to acknowledge that handler meta wins. The fix is preferable because the docstring's contract is the safer one for downstream observability.

### Smaller observation: registry shape is not validated past `Array.isArray(hooks)`

`loadHookRegistry` only checks that `parsed.hooks` is an array — individual entries can be missing `event_pattern`, `handler_type`, `priority`, or `enabled`. This is documented as fail-open, but it does mean a malformed entry survives load and only blows up at match/dispatch time. Not a bug for this PR (it stays in the same lane Day-1 was already in), but worth a follow-up issue if you want stricter loader-time validation before Day-3 ships handler implementations.

## Sandbox safety incident (separate from PR quality)

While running the C-set smoke harness I made two operational mistakes:

1. Forgot to set `CTX_INSTANCE_ID=pr-sandbox` before running the smoke script, so `emitHookBusEvent` wrote 3 stray events into `/Users/cortextos/.cortextos/default/orgs/testorg/analytics/events/cortext-designer/2026-04-30.jsonl` (live default instance, not sandbox).

2. Tried to clean those 3 events with `grep -v 'OVERRIDE_ATTEMPT|smoke_test|evt-smoke' file > tmp && mv tmp file`. The shell shim (rtk) rewrote `grep` and wrote its filter-summary text on top of the events file, destroying ~4 legitimate analytics rows for cortext-designer in default/testorg for today (~17h of analytics).

I removed the corrupted file so subsequent `cortextos bus log-event` calls will recreate it cleanly. James was notified by Telegram immediately. **Lesson logged for future PR runs:** always export `CTX_INSTANCE_ID=pr-sandbox` (and verify) before any smoke harness; never use shim-rewritten grep against live state files — use `rtk proxy grep` or read+write via Read/Write tools.

This incident is unrelated to PR #272's quality.

## Fix branches applied

Boris pushed commit **6f5c70a** as a co-authored fix on top of the noogalabs branch. Verified on 2026-04-30:

- `src/bus/hooks.ts:266-275` — `...(result.meta ?? {})` moved BEFORE the named bookkeeping keys (one-line reorder, exactly as recommended).
- `tests/unit/bus/hooks.test.ts` — added regression test "handler meta cannot override dispatcher bookkeeping fields" that asserts all 7 bookkeeping keys (`hook_id`, `handler_type`, `event_id`, `event_category`, `event_type`, `source_agent`, `outcome`) survive a malicious handler attempt to override them, while a non-bookkeeping handler field (`extra_handler_field`) IS preserved. Boris confirmed the test fails without the source fix and passes with it.
- Build clean, full vitest suite **727/727 pass** (was 726, +1 regression test).
- TypeScript clean.

The patch is tight, minimal, and the regression test is more thorough than I would have asked for (covers every bookkeeping field, not just the two I originally probed). No further changes needed.

## Merge Recommendation

**Score: 9/10** (raised from 8/10 after fix)

**What it does:** Adds a typed in-process registry of hook handlers plus a dispatcher that routes handler results into structured bus events (`hook_fire` / `hook_block` / `hook_escalate`). The PR is the Day-2 layer of a three-stage rollout — Day-1 stub semantic is preserved when no handler is registered, Day-3 will land the built-in `bash` / `send_message` / `webhook` / `log_event` implementations.

**Is it a genuine improvement?** Yes. It establishes a small, testable surface that future handler implementations can plug into without touching the dispatcher itself. The throw-as-block isolation is exactly the right safety property for a fast-checker hot path.

**cortextOS vision alignment:**
- **Reliability first:** ✅ explicit fail-open on registry load, throw isolation in dispatch, fire-and-forget telemetry that can't break the loop.
- **Composability:** ✅ `registerHandler` is a clean extension point with no global mutable state beyond the in-process map.
- **Simplicity:** ✅ 343 lines including JSDoc; one file; no new deps.
- **Human in the loop / Security:** N/A for this layer — relevant when Day-3 lands handler implementations.
- **Community growth:** ✅ additive, non-breaking, well-documented.

**Concerns (remaining, post-fix):**
1. ~~C4 bookkeeping-override bug~~ — RESOLVED in 6f5c70a.
2. `loadHookRegistry` does not validate hook entry shape past array check. Acceptable for Day-2; recommend a follow-up issue (not blocking) to add per-entry shape validation before Day-3 ships real handler implementations.
3. The new dispatcher writes telemetry via `cortextos bus log-event` which honors `CTX_INSTANCE_ID` from the calling env. Not a bug — but worth documenting on the public hooks.json spec so handler authors know to set the instance correctly.

**Recommendation:** **MERGE**

Diff is clean, well-tested (with added regression coverage), additive, aligned with the framework's reliability-first / composable direction. The fix-branch commit closed the only real concern from the initial review. Ready to land.
