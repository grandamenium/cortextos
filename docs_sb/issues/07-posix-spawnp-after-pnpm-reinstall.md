# 07 — `posix_spawnp failed` after `pnpm install` leaves fleet silently dead for 9h

**Severity:** P1 (silent multi-hour outage; no operator alert fired)
**Status:** Resolved (daemon restarted 2026-05-14 22:05 +08); fix in flight on `fix/spawn-failure-self-heal`
**Detected:** Operator-reported "cortextOS is dead and it has not self-restarted" — 2026-05-14 ~22:00 +08
**Duration:** ~9h 20m of degraded fleet (boss/analyst/token-auditor down). devops-c unaffected.

## Summary

At 2026-05-14 07:57 (+08) `pnpm install` ran on the fork (introducing `pnpm-workspace.yaml`, regenerating `pnpm-lock.yaml`, and rewriting `node_modules/`). The long-running cortextos-daemon (PID 51492, alive since 2026-05-12 00:41) kept its in-memory `node-pty` native binding loaded against the now-stale `node_modules/.pnpm/node-pty@1.1.0/.../prebuilds/.../spawn-helper` path. Every subsequent attempt to spawn a fresh agent PTY threw `Error: posix_spawnp failed.` and the affected agent stayed in `crashed` state with no auto-retry. Three of the seven enabled agents tripped this between 04:43 and 13:42 UTC; none recovered until the daemon was manually restarted.

The fleet's scheduled work — heartbeats, morning-review, daily-brief, kb-refresh, hourly-ingest, threshold-check, standby-enforcer, check-approvals — silently failed to dispatch for the entire window. No operator alert ever fired.

## Timeline (all times +08 unless noted)

| Time | Event |
|---|---|
| 2026-05-12 00:41 | cortextos-daemon (PID 51492) started; loaded node-pty native binding |
| 2026-05-14 07:57 | `pnpm install` ran on the fork; replaced `node_modules/`; `pnpm-workspace.yaml` and `pnpm-lock.yaml` written |
| 2026-05-14 12:43 (04:43Z) | analyst fired its 6h `cortextos bus hard-restart`. Daemon stopped analyst cleanly, then `posix_spawnp failed` on respawn → analyst stuck `crashed` |
| 2026-05-14 12:44 (04:44Z) | boss fired its 6h hard-restart. Same failure → boss stuck `crashed` |
| 2026-05-14 ~13:00 (05:00Z) | morning-review cron tried to inject prompt into boss → `injectAgent returned false — agent may not be running`. Cron-scheduler "advanced next slot to avoid busy-loop" (correct behavior — but no escalation) |
| 2026-05-14 13:00+ | Every recurring cron targeting boss/analyst/token-auditor failed to dispatch. Loop continues silently every 30 min |
| 2026-05-14 ~13:42 (05:42Z) | token-auditor entered same failure mode |
| 2026-05-14 ~22:00 (14:00Z) | Operator notices, asks Claude to investigate |
| 2026-05-14 22:05 | `pm2 restart cortextos-daemon` → new daemon reloads node-pty against fresh spawn-helper → all 7 agents online in 17s |

devops-c (gpt-5-codex) was already running before the reinstall and stayed up the entire 9h — it never needed a respawn.

## Root cause

The daemon's PTY spawn path has asymmetric crash recovery:

**`AgentProcess.handleExit()`** — `src/daemon/agent-process.ts:379` — fires when the PTY *exits* unexpectedly. It increments `crashCount`, appends a `CRASH` row to `restarts.log`, applies exponential backoff (`5s × 2^n`, capped at 5min), schedules `setTimeout(this.start, backoff)`, and halts at `max_crashes_per_day` (default 10).

**`AgentProcess.start()`'s catch block** — `src/daemon/agent-process.ts:174-178` — fires when `pty.spawn()` *itself* throws (i.e. the child never started, `posix_spawnp failed`). It does only this:

```ts
} catch (err) {
  this.log(`Failed to start: ${err}`);
  this.status = 'crashed';
  this.notifyStatusChange();
}
```

No `crashCount++`. No `restarts.log` entry. No `setTimeout` retry. No halt budget. The agent goes to `crashed` and sits there until something external (an IPC `restart-agent` from the cron's `hard-restart` prompt) re-triggers `start()` — which fails the same way against the same stale node-pty binding inside the same daemon process.

The Telegram alert that *did* fire (`agent-manager.ts:272-282`) said:

> "Agent boss crashed (crash #?) — auto-restarting"

— which is wrong on two counts: (1) "auto-restarting" is a lie in the spawn-failure path because nothing is scheduled, and (2) `crashCount` is `?` because the spawn-fail path never incremented it. And the alert was sent to the boss bot chat. Saurav's operator chat is the boss bot — but the analyst/token-auditor alerts went to their own bot chats, which weren't being watched.

## Contributing factors

1. **No file-watcher on `node_modules`.** The daemon has no way to know its native binding has been invalidated by a reinstall. `cortextos doctor` *did* detect "spawn-helper permissions missing" later, but it's an on-demand command — it doesn't run as a cron, and it can't notify the running daemon to reload anything.
2. **Cron-scheduler dispatch failures don't escalate.** "Advance the slot to avoid busy-loop" is the right behavior for a one-off miss, but sustained failure across 8+ different crons across 3 agents over 9h is exactly the signature of "the daemon needs a restart". No alert fires.
3. **Per-agent SessionEnd hook can't catch this class of failure.** `hook-crash-alert.ts` runs from inside Claude Code's `SessionEnd` event. In a `posix_spawnp failed`, Claude Code never starts, so the hook never fires, so `.crash_count_today` never grows, so no quota alert ever lands.
4. **No installed self-healing scripts on this machine.** `scripts/self-healing/{watchdog,agent-recover,usage-monitor,compact-boundary-watcher}.sh` are in the repo, but their launchd plists were never loaded here (`launchctl list | grep cortextos` returned empty). And even if installed, `watchdog.sh` watches Telegram poller errors and `agent-recover.sh` watches alive-but-hung PTYs — neither matches the spawn-failure signature.
5. **macOS reinstall timing.** macOS pnpm/npm reinstalls can briefly leave the prebuild binary without exec permissions. Doctor auto-`chmod`'s it on next run, but the already-loaded daemon doesn't pick that up.

## Why nothing self-healed

The recovery surface today is built around three assumptions, all of which broke:

| Recovery surface | Trigger | Why it didn't fire |
|---|---|---|
| `AgentProcess.handleExit` | PTY exits unexpectedly | PTY never started — `posix_spawnp` threw before the exit handler was registered |
| SessionEnd `crash-alert` hook | Claude Code session ends | Claude Code never started |
| Telegram `Agent X crashed` alert (agent-manager.ts:273) | `status === 'crashed'` | Did fire, but message was misleading + went to per-agent bot chats |
| Daemon-level crash-loop alert (`shouldSendCrashLoopAlert` in daemon/index.ts) | ≥3 daemon crashes in 15min | Daemon process never crashed — the *agents* did. Existing tracker is daemon-scoped, not agent-scoped |
| `scripts/self-healing/watchdog.sh` | Telegram poller errors accumulate | Not installed on this machine; also targets the wrong signal |
| `cortextos doctor` | Operator runs it | Operator didn't run it; doctor isn't a cron |

## Prevention — what we're changing

Three layers, ordered by cost and blast-radius reduction. **Layers 1+2 are landing on `fix/spawn-failure-self-heal`**. Layer 3 is a follow-up.

### Layer 1 — Spawn-failure retry symmetry (in-daemon)

`src/daemon/agent-process.ts`: the `start()` catch block becomes a peer of `handleExit()`. On spawn failure:

- Increment `crashCount`, persist `SPAWN-FAIL` row to `restarts.log`.
- Schedule `setTimeout(this.start, backoff)` with the same exponential backoff.
- Halt at `max_crashes_per_day`.
- Distinguish the Telegram alert: `"Agent X failed to spawn (posix_spawnp) — daemon may need restart"` vs the existing `"crashed (#N) — auto-restarting"`.

Why this matters even without Layer 2: a stuck `crashed` state becomes a *loud, retrying, eventually-halting* failure that surfaces in restarts.log and Telegram immediately — visible within 5 seconds of the first failure instead of 9 hours.

### Layer 2 — Cross-agent spawn-storm → daemon self-restart

New module `src/daemon/spawn-failure-tracker.ts` mirroring the existing daemon-crash-loop pattern in `daemon/index.ts`. Tracks `{ts, agent, errSignature}` events in `state/.spawn-failure-history.json`. Detection rule:

- `posix_spawnp failed` (or any spawn-helper error) reported by ≥2 *distinct* agents within 5 min → CRITICAL.

CRITICAL response:
1. Telegram alert to `CTX_OPERATOR_CHAT_ID` (the operator chat, NOT per-agent bots — same fallback chain as the existing daemon crash-loop alert).
2. `process.exit(1)` — PM2's `cortextos-daemon` is configured with `autorestart: true`, so the daemon respawns. The new daemon loads node-pty fresh, restoring the ability to spawn PTYs.

Why exit(1) is safe here: the only agent affected by a daemon respawn is the currently-running set; they'll be re-spawned by the new daemon's startup loop. The structural problem (stale native bindings) is unfixable in-process — only a daemon restart resolves it.

### Layer 3 — Post-pnpm hook (deferred)

Add `package.json:scripts.postinstall` that auto-restarts the daemon if PM2 has a `cortextos-daemon` record. Cheap, but doesn't help if pnpm is invoked with `--ignore-scripts`. Layers 1+2 handle the more general case (any reinstall, any external cause); the postinstall hook is belt-and-suspenders.

## Lessons

- **Asymmetric error handling is a latent class of bug.** Two code paths can lead to "agent crashed" but only one has recovery. Audit other catch-vs-onExit pairs in the codebase.
- **"Advance the slot to avoid busy-loop" is correct, but it needs an escalation peer.** A scheduler that silently skips work across multiple consumers for hours is indistinguishable from "everything is fine".
- **Long-running daemons that depend on native bindings are vulnerable to `node_modules` reinstalls.** Reload-on-mtime-change is hard; explicit operator-triggered restart-after-install (or a watcher) is easier.
- **Per-agent alerts go to per-agent bot chats.** Anything described as "the fleet is broken" must use the operator chat, not the affected agent's bot.

## Verification

After fix lands:

1. **Layer 1 unit test**: spawn-failure path increments crashCount, appends `SPAWN-FAIL` to restarts.log, schedules retry, halts at maxCrashesPerDay.
2. **Layer 2 unit test**: spawn-failure-tracker emits CRITICAL after 2 distinct agents fail in 5min; respects 30min cooldown; ignores intra-agent repeats.
3. **Integration test**: simulate `posix_spawnp failed` from a mocked PTY → daemon exits(1) within 1s of second-agent failure.
4. **Manual repro**: in a test instance, `pnpm install` while daemon runs → trigger one agent restart → confirm new behavior (loud retry, halt, Telegram operator alert, daemon respawn).
