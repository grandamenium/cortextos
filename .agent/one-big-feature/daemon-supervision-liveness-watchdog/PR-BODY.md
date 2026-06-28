## Daemon liveness watchdog + per-instance supervision

Adds a stall/liveness watchdog so a wedged agent (long-silent, no tool activity)
is detected and recovered instead of sitting "healthy" forever, plus per-instance
CLI resolution so daemon ops target the right instance. Closes the frank2
loop-stall / false-healthy-heartbeat class (RCA: `larry/memory/2026-06-10-frank2-stall-rca.md`).

Built one-big-feature (spec + master-plan + P1–P5 in
`.agent/one-big-feature/daemon-supervision-liveness-watchdog/`), architect-reviewed,
adversarial build-review PASS.

### What's in it
- **Stall watchdog** (`fast-checker.ts`): tool-activity wiring + long-turn storm guard.
  Will not kill a healthy agent mid-long-turn; stdout is excluded from the activity
  signal (verified in build-review). Kill-switch `stall_watchdog_enabled` **defaults
  `false`** — opt-in per agent.
- **Per-instance CLI resolution** (`resolve-instance-id.ts` + `start/stop/restart/
  enable-agent/notify-agent/doctor`): commands resolve the instance id instead of
  assuming the default (fixes the `--instance cortextos1` papercut).
- **Registry reconcile** (`agent-manager.ts`): PID-only `reconcileDeadRegistryEntry`;
  preserves the BUG-011 dormant-branch regression alarm.

### ⚠️ Reconciliation note (please read)
This was built on base `25921e5` (PR #14). Since then `fork/main` merged **PR #20**
(per-agent Claude session isolation) and **PR #22** (PTY prompt-injection hardening),
which independently touched 6 of the same files. I rebased the feature onto current
`fork/main` and resolved 3 conflicts:
- `start.ts`, `enable-agent.ts` — **union**: kept fork/main's session-isolation /
  cwd-policy logic AND layered the instance-resolution change on top.
- `agent-manager.ts` — kept the watchdog's PID-only reconcile (the reviewed design),
  preserved fork/main's intent via the reconcile.
- `fast-checker.ts`, `types/index.ts` auto-merged clean. **Confirmed PR #22's
  `sanitizeForPtyInjection` / `wrapFenceSafe` hardening survives intact** (25 refs).
- `tests/unit/daemon/agent-manager-session-isolation.test.ts` — PR #20 added
  occupied-slot tests asserting the **old** stop-once behavior. The watchdog
  deliberately changes occupied-slot handling to **PID-only reconcile** (dead PID ⇒
  reconcile + start cleanly; live PID ⇒ queue `pendingRestarts`, no stop). These two
  tests were updated to assert the new semantics. This is an intentional behavior
  change to occupied-slot handling — calling it out explicitly.

### Disclosures (flag for explicit approval)
- **SF-2 (beyond original scope):** `start.ts` adds `requireDaemonOfflineForBootstrap`
  — `cortextos start` now refuses to auto-bootstrap a new daemon when an existing one
  is running-but-unresponsive, rather than bouncing the whole fleet. This is a
  behavior change beyond pure instance-resolution. Want your explicit nod on it.
- **SF-1 (follow-up, not in this PR):** `hook-loop-detector` resolves its state dir via
  `CTX_ROOT` while `hook-idle-flag` uses `CTX_INSTANCE_ID` — same dir at runtime today,
  but worth hardening to match in a follow-up.

### Test status (honest — verified by me, env-clean)
- **1891 pass, 1 skip.** `tsc --noEmit` strict + `npm run build` clean.
- **12 failures are PRE-EXISTING and unrelated**: `tests/unit/bus/hooks.test.ts` ×7,
  `tests/unit/hooks/hook-crash-alert.test.ts` ×4, `tests/unit/hooks/hooks.test.ts`
  (`isClaudeDirOperation` symlink-escape #18) ×1. **All 12 fail identically on clean
  `fork/main` (e7d0341)** — this feature touches none of them. (Separately worth a
  look: fork/main main is shipping with 12 red tests.)

### Rollout
Enable `stall_watchdog_enabled: true` on **Frank2 only** first, validate in production,
then fleet-wide.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
