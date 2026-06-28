# 06 — Rebase Reconciliation onto fork/main (codexer task)

## Why this exists
The daemon-supervision build PASSED adversarial review, but it was built on base
`25921e5` (PR #14 merge). Since then `fork/main` (clearworks-ai/cortextos) advanced
with **PR #20** (per-agent Claude session isolation / cwd-policy) and **PR #22**
(upstream sync 2026-06-08 — PTY prompt-injection hardening). Those PRs independently
modified 6 of the same files this build touches. The feature must be **rebased onto
current `fork/main`** with conflicts resolved before it can PR.

DO NOT lose: (a) fork/main's session-isolation logic, (b) fork/main's `fast-checker.ts`
prompt-injection hardening (`sanitizeForPtyInjection` / `wrapFenceSafe`), (c) the
reviewed watchdog semantics, (d) SF-2 bootstrap guard, (e) the BUG-011 dormant-branch
invariant in `agent-manager.ts`.

## The complete feature is one commit
Branch `feat/daemon-supervision-liveness-watchdog` @ `5cce98f` — 26 files,
+1041/-70, includes `src/daemon/ipc-server.ts` (defines `IPCClient.probeAvailability`,
which `start.ts`'s `requireDaemonOfflineForBootstrap` depends on — NOT on fork/main).

## Command
```
cd ~/code/cortextos
git checkout feat/daemon-supervision-liveness-watchdog
git rebase --onto fork/main 943239e feat/daemon-supervision-liveness-watchdog
```
`fast-checker.ts`, `types/index.ts`, `fast-checker.test.ts` AUTO-MERGE clean (verified
— disjoint regions; fork/main's security hardening survives untouched). 3 files conflict.

## Conflict resolution recipe

### Regular pattern (start.ts imports, enable-agent.ts ×4 hunks, start.ts action sig)
fork/main (`HEAD` side) added session-isolation imports/logic that reference
`options.instance` directly. Codexer's side (`>>>> 5cce98f`) swapped to
`resolveInstanceId(options.instance)` → `instanceId` and tightened the options type
`{ instance: string }` → `{ instance?: string }`. **Resolution = UNION:**
1. Keep BOTH import groups (fork/main's `../utils/agent-session-isolation.js` imports
   AND codexer's `./resolve-instance-id.js`).
2. Keep fork/main's session-isolation body blocks verbatim
   (`validateClaudeWorkingDirectoryPolicy`, `findAgentDirAndOrg`, `readAgentConfigSafe`,
   `normalizeConfiguredWorkingDirectory`, `archiveClaudeProjectDirForLaunchDir`,
   `discoverProjectRoot`, the `agentLocation`/`launchDir` derivations).
3. Apply codexer's instance change ON TOP: add `const instanceId = resolveInstanceId(options.instance);`
   as the first line of each `.action`, change the option type to `{ instance?: string; ... }`,
   and replace every `readEnabledAgents(options.instance)` → `readEnabledAgents(instanceId)`.

### start.ts action body (2nd hunk) — keep BOTH behaviors
- Keep codexer's `const instanceId = resolveInstanceId(options.instance);` and
  `const shouldBootstrapDaemon = await requireDaemonOfflineForBootstrap(ipc);` (SF-2).
- fork/main's side used `options.instance` + `ipc.isDaemonRunning()` and (below the
  conflict) the session-isolation/cwd-policy path. Thread fork/main's session-isolation
  logic through using `instanceId` instead of `options.instance`. The SF-2
  `requireDaemonOfflineForBootstrap` REPLACES the bare `isDaemonRunning()` gate
  (that is the intended anti-fleet-bounce behavior). Preserve fork/main's
  cwd-policy/session-isolation calls that follow.

### agent-manager.ts (1 hunk) — JUDGMENT, preserve BUG-011
Both sides rewrote the `startAgent` occupied-slot path:
- fork/main: clears a slot only when `getStatus()` is `stopped|crashed|halted`.
- codexer: `reconcileDeadRegistryEntry(name)` (PID-only reconcile) + the BUG-031/BUG-011
  dormant-branch warning with `daemonJustCrashed`.
**Take codexer's side as the base** (it is the reviewed watchdog reconcile that the
build was verified against — "PID-only reconcile preserves BUG-011"). Then confirm
fork/main's stale-status intent is already covered by `reconcileDeadRegistryEntry`
(dead PID ⇒ slot cleared). If fork/main's branch added any NEW status value or side
effect not covered by the reconcile, fold it in; otherwise codexer's side stands.
Do NOT drop the BUG-011 dormant-branch warning or the `daemonJustCrashed` post-crash
info-log path.

## Verify (env-clean — scrub CTX_* first)
```
env -u CTX_AGENT_DIR -u CTX_PROJECT_ROOT -u CTX_ROOT -u CTX_INSTANCE_ID \
    -u CTX_AGENT_NAME -u CTX_TELEGRAM_CHAT_ID npm run build && \
env -u CTX_AGENT_DIR -u CTX_PROJECT_ROOT -u CTX_ROOT -u CTX_INSTANCE_ID \
    -u CTX_AGENT_NAME -u CTX_TELEGRAM_CHAT_ID npm test
```
tsc strict + build must be clean. Expected test baseline: 11 PRE-EXISTING unrelated
failures (`tests/unit/bus/hooks.test.ts` ×7 + `hook-crash-alert.test.ts` ×4 — fail
identically on clean fork/main; feature touches neither). Report the EXACT pass count —
do not round. Confirm `sanitizeForPtyInjection`/`wrapFenceSafe` still present in
`src/daemon/fast-checker.ts` after the rebase.

## Deliverable
Do NOT push, do NOT open a PR, do NOT merge. After the rebase lands clean + tests pass,
report back to Larry: the resolved-conflict diff for the 3 files (`git show` or
`git diff fork/main...HEAD -- <3 files>`), the exact test pass/fail counts, and
build/tsc status. Larry re-reviews the reconciliation delta, then opens the PR for Josh.
