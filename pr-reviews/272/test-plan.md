# PR #272 — Test Plan

**PR:** feat(bus): hooks framework — Day-1 stub + Day-2 per-handler wiring + telemetry
**Author:** noogalabs (commit attribution: collie via dane dispatch)
**Branch:** feat/bus-hooks-framework
**Diff:** +600/-0, 2 files (`src/bus/hooks.ts` 343 lines, `tests/unit/bus/hooks.test.ts` 257 lines)

## Stage 1 — Static Gates

| Gate | Result |
|---|---|
| 1. No new external dependencies | PASS — package.json unchanged |
| 2. No hardcoded secrets | PASS — grep clean for sk-ant/api_key/bot_token/password/secret |
| 3. Build | PASS — `npm run build` success in 33ms |
| 4. Tests | PASS — 726/726 vitest tests pass (including 18 new hook tests) |
| 5. TypeScript | PASS — `tsc --noEmit` clean |

## Stage 2 — Risk Triage

**Tier: LOW**

Justification:
- New file only (`src/bus/hooks.ts`); no existing module modified.
- Grep confirms zero callers of the new module outside its own test file. Code is "dead" until Day-3 PR wires consumers.
- The only side-effect is a fire-and-forget `execFile('cortextos', ['bus', 'log-event', ...])` invocation — uses an existing telemetry surface, no new IPC/network primitive.
- Backwards-compat verified: empty registry → Day-1 stub semantic (`{action: 'fire', reason: 'no_handler_registered'}`).
- Author's risk claim ("low") aligns with what I observe in the diff.

Adjacent surfaces NOT touched by the diff: daemon spawn, PTY management, OAuth, install scripts, file permissions, fast-checker, telegram poller, dashboard, knowledge base, task system, heartbeat, cron, metrics.

## Stage 3 — Behavior Scenarios

Because the new code has no live consumer in this PR, the bulk of behavioral coverage lives in the unit tests. The unit tests are comprehensive (see Scenario set A below). Sandbox-runtime checks focus on **regression of adjacent surfaces** and **runtime smoke-test of the dispatcher** via a synthetic registration.

### Scenario set A — Unit-test surface (verify, don't duplicate)

The 18 unit tests cover the following behavior. The sandbox stage will re-run them in the build to confirm parity:

1. `loadHookRegistry` returns empty registry when `hooks.json` missing → fail-open
2. `loadHookRegistry` returns empty registry on malformed JSON → fail-open
3. `loadHookRegistry` parses valid registry
4. `matchHooks` filters enabled / category / type
5. `matchHooks` skips disabled hooks
6. `matchHooks` honors `agent_filter` (own & cross)
7. `matchHooks` sorts by priority descending
8. `matchHooks` deep-matches metadata (extra event keys allowed)
9. `dispatchHook` falls back to `hook_fire` (no_handler_registered) when no handler
10. `dispatchHook` emits `hook_fire` (implicit_default) when handler returns undefined
11. `dispatchHook` emits `hook_fire` with custom meta when handler returns `{action:fire,meta}`
12. `dispatchHook` emits `hook_block` when handler returns `{action:block}`
13. `dispatchHook` emits `hook_escalate` when handler returns `{action:escalate}`
14. `dispatchHook` treats handler throw as `hook_block` with `handler_threw` reason
15. `dispatchHook` awaits async handlers
16. `dispatchHook` always carries `hook_id`, `handler_type`, `event_id` in meta
17. `registerHandler` replaces existing handler and returns prior
18. `clearHandlerRegistry` removes all registrations

### Scenario set B — Adjacent regression checks (sandbox)

**B1: Build still succeeds on PR branch**
- Action: `npm run build` against pr-272-test branch in sandbox
- Expected: clean build, no new TS errors
- Wrong: any error or warning related to the new module being un-imported

**B2: Existing test suite still passes**
- Action: `npx vitest run` against pr-272-test branch in sandbox
- Expected: all pre-existing tests still pass, including the 18 new ones
- Wrong: any pre-existing test now failing

**B3: Daemon starts cleanly on PR branch**
- Action: build sandbox copy on PR branch, start daemon, verify no crash for 30s
- Expected: daemon up, agents register, no error logs referencing `hooks.ts`
- Wrong: crash, hang, or any new ERROR-level log line

**B4: `cortextos bus log-event` accepts the emitter shape**
- Action: invoke `cortextos bus log-event action hook_fire info --meta '{"hook_id":"smoke","handler_type":"log_event","event_id":"e1","event_category":"action","event_type":"smoke","source_agent":"sandbox","outcome":"smoke_test"}'` directly
- Expected: command exits 0, event written to `events/<agent>/<date>.jsonl`
- Wrong: command rejects shape, exits non-zero, or no event recorded
- Rationale: dispatcher uses this exact CLI shape — if it doesn't accept it, every dispatch will silently lose telemetry.

### Scenario set C — Edge cases the unit tests do not cover

**C1: dispatcher with `CTX_ROOT` unset**
- Action: call `dispatchHook` (via a node REPL or smoke harness) with `CTX_ROOT` env var unset
- Expected: `appendActivityLine` swallows error silently (path becomes `logs/<agent>/hooks.log` relative to CWD or fails-open)
- Wrong: exception propagates and breaks dispatchHook
- Rationale: `appendActivityLine` does `join(process.env.CTX_ROOT ?? '', ...)` — empty CTX_ROOT means relative path; `mkdirSync` is wrapped in try/catch so should be safe, but worth verifying because the comment claims "never throw."

**C2: `emitHookBusEvent` when `cortextos` is not on PATH**
- Action: shadow PATH so `cortextos` is unavailable, call `dispatchHook`
- Expected: dispatcher does not throw — execFile failure is swallowed
- Wrong: exception leaks to caller (would break a future fast-checker integration that calls dispatchHook in a loop)
- Rationale: execFile errors callback async; the synchronous try/catch in `emitHookBusEvent` catches the spawn-attempt synchronous throw but not the async exit-1. The fire-and-forget callback is `() => {}`, so async errors are dropped. This is acceptable but worth confirming.

**C3: Registry with hook entry missing required fields**
- Action: write `hooks.json` containing a hook with no `event_pattern` or no `handler_type`
- Expected: `loadHookRegistry` does not validate field shape (only checks `Array.isArray(parsed.hooks)`); the malformed entry will be passed through and only fail at `matchHooks` / `dispatchHook` time
- Wrong: silent crash, or registry returned as empty when one entry is malformed (would mask other valid entries)
- Rationale: there is NO schema validation beyond presence of the `hooks` array. This is documented as fail-open, but is a notable gap — surface it in the result.md.

**C4: dispatchHook return value with `meta` colliding with bookkeeping**
- Action: register a handler that returns `{action: 'fire', reason: 'x', meta: {hook_id: 'OVERRIDE', source_agent: 'OVERRIDE'}}` and dispatch
- Expected: per the JSDoc claim, `result.meta` is "merged into the bus event meta, never used to override the dispatcher's own bookkeeping fields"
- Wrong: actually examining `dispatchHook` line 266-275:
  ```
  emitHookBusEvent(eventName, {
    hook_id: hook.id,
    handler_type: hook.handler_type,
    event_id: event.id,
    event_category: event.category,
    event_type: event.event,
    source_agent: event.agent,
    outcome: result.reason ?? `${result.action}_no_reason`,
    ...(result.meta ?? {}),  // <-- spread AFTER bookkeeping → overrides them
  });
  ```
  The comment in the JSDoc CONTRADICTS the implementation. `result.meta` is spread AFTER the bookkeeping fields, meaning a malicious or buggy handler CAN override `hook_id`, `outcome`, etc. **This is a small but real bug.**
- Severity: low — blast radius is bus telemetry only, no security impact. But the docstring is misleading.

## Iteration plan

- Iteration 1: run B1-B4 + spot-check C1-C4 in sandbox.
- Stop early if any B-scenario fails (regression).
- Surface C4 as a recommendation in result.md regardless of test outcome (it's a docstring/code mismatch, not a runtime failure).
