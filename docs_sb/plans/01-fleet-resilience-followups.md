# 01 — Fleet resilience follow-ups

**Owner:** Saurav
**Origin:** Issue #07 (`docs_sb/issues/07-posix-spawnp-after-pnpm-reinstall.md`) — May 14 9h silent outage post-mortem
**Status:** Planned — pick items off the top as capacity allows
**Created:** 2026-05-15

## Why this exists

Issue #07 surfaced one specific silent-failure mode (`posix_spawnp failed`). PRs #37 and #40 closed *that* mode — symmetric crash recovery, cross-agent storm detection, auto-chmod at startup + postinstall. The May 14 morning shape becomes a 30-second-MTD event instead of a 9-hour silent outage.

But the incident also revealed a *class* of latent gaps where the daemon can be unhealthy in ways nothing alerts on. This plan is the punch list for those gaps. Each item is self-contained — you can pick one off cold and ship it without reading the others.

The order is tier (high/medium/long-term) → impact within tier. Numbers are stable IDs for cross-reference; they're not a build order.

---

## Tier 1 — Same week (high impact, low scope)

### #1 — Cron-scheduler dispatch-failure escalation

**Problem.** When `injectAgent` returns false (agent not running), the daemon's cron scheduler logs a WARNING and advances the slot to "avoid busy-loop". Correct behavior for a one-off miss; silent over hours when the same agent stays down. May 14 had 8+ different crons across 3 agents fire-and-fail every 30 minutes for 9 hours with zero escalation.

**Scope.** Mirror the spawn-failure-tracker pattern but scoped to cron dispatch failures.

**Files.**
- New: `src/daemon/cron-dispatch-tracker.ts` (mirrors `spawn-failure-tracker.ts`)
- Wire into: `src/daemon/cron-scheduler.ts` at the existing "dispatch failed, advancing next slot" branch

**Detection rule.**
- ≥3 distinct cron names fail dispatch in 30 min for the same target agent → operator-chat Telegram CRITICAL
- 60-min cooldown
- Persist to `state/.cron-dispatch-failure-history.json`

**Alert text.**
```
⚠️ Cron dispatch failure storm for agent "boss"
3 distinct cron(s) failed to inject in 30 min: heartbeat, morning-review, check-approvals
Boss's last successful spawn: 2026-05-14T04:43Z (9h ago)
Likely "cortextos restart boss" or "pm2 restart cortextos-daemon"
```

**Acceptance.**
- Unit test: 3 distinct cron names fail for the same agent → emits CRITICAL once, then cooldown gates
- Same agent + same cron repeating doesn't count toward distinctness (mirrors the spawn-failure-tracker rule)
- Integration test: spy on cron-scheduler.onFire-failed hook, fire 3 different crons, assert alert + cooldown

**Why this is #1.** The exact gap that hid May 14's outage from the operator. Highest-signal change.

---

### #2 — Heartbeat-staleness watchdog

**Problem.** Agents write heartbeats to `state/<agent>/heartbeat.json`. Today there's no daemon-side watcher that flags staleness. If an agent's PTY is alive but Claude is wedged inside a long tool call, restarts.log shows nothing and the daemon thinks the agent is fine.

**Scope.** Daemon polls each agent's heartbeat file every 60s; if `now - heartbeat.ts > config.heartbeat_stale_threshold_minutes` (default 10), escalate.

**Files.**
- New: `src/daemon/heartbeat-staleness-watcher.ts`
- Wire into: `src/daemon/agent-manager.ts` startup loop (one watcher instance per agent)
- Add to: `AgentConfig` — `heartbeat_stale_threshold_minutes?: number` (default 10)

**Detection rule.**
- File missing OR ts older than threshold → mark "stale"
- First detection: Telegram operator alert with last-heartbeat-age + last-known task
- Re-alert every 30 min while stale (NOT a one-shot)
- Clears automatically when heartbeat updates

**Alert text.**
```
⚠️ Agent "boss" heartbeat stale: 14m (threshold 10m)
Last task: "heartbeat — fleet healthy, awaiting Saurav direction"
Last heartbeat: 2026-05-15T13:42:11Z
Agent status: running (PID 12345)
Suggested: `cortextos bus inject boss "hey, ping?"` to nudge
```

**Acceptance.**
- Unit test: stale heartbeat triggers alert; fresh heartbeat does not
- Re-alert cadence test (FakeTimers): no alert at 10m, alert at 11m, re-alert at 41m
- Heartbeat update mid-stale clears the watcher

**Why this is #2.** Catches the hung-but-alive failure mode that the existing recovery surfaces all miss. Sister to `scripts/self-healing/agent-recover.sh` but daemon-native (so it ships with the daemon, doesn't depend on launchd plist installation).

---

### #3 — Dashboard EADDRINUSE auto-recovery

**Problem.** `cortextos-dashboard` is currently at **327 PM2 restarts** because it keeps hitting `EADDRINUSE :3000` against some other process. PM2 respawns it into the same conflict forever. (Unrelated to issue #07 but exemplifies "self-restart without diagnosing root cause is just thrash".)

**Scope.** Pre-bind check in the dashboard launcher: `lsof -tiTCP:<port> -sTCP:LISTEN` before `next start`. If occupied: log loudly, try next port (3010, 3020, ...) up to N attempts, then fail-fast (don't let PM2 thrash forever).

**Files.**
- `src/cli/dashboard.ts` (or wherever the dashboard launcher lives)
- Maybe: `ecosystem.config.js` — reduce `max_restarts` for the dashboard process to 3 so a real failure surfaces fast

**Acceptance.**
- Manual: occupy port 3000, run `cortextos dashboard` → logs "port 3000 in use by PID X, trying 3010"
- Unit test: mock port-probe; assert iteration up to fallback ports

**Why this is #3.** A live ongoing crash loop. 30-min fix.

---

### #4 — Doctor as a periodic cron

**Problem.** `cortextos doctor` already detects most known operational issues. It's only run on demand. Saurav-level "I noticed the fleet is dead" is the trigger, not "doctor flagged something".

**Scope.** Daemon runs `doctor` internally every 30 min (in-process, no shell-out). Diffs current results against last run. On any NEW `warn` or `fail` check → operator-chat Telegram with the diff.

**Files.**
- Refactor: extract doctor's check-collection loop from `src/cli/doctor.ts` into `src/utils/health-checks.ts` (returns `Check[]`)
- New: `src/daemon/doctor-cron.ts` — schedules 30-min runs, compares to last run, alerts on delta
- Wire into: daemon startup

**Detection rule.**
- Compare current `Check[]` to previous (saved to `state/.doctor-last-run.json`)
- New `warn` or `fail` (by check name) → alert
- Resolved checks → resolved alert ("Doctor check 'X' is now passing")
- Suppress no-change runs (the common case)

**Acceptance.**
- First run after deploy: alerts on every current `warn`/`fail` (baseline) — cooldown gates to 1 alert
- Second run with same state: silent
- Third run with new fail: alerts ONLY on the new fail

**Why this is #4.** Highest leverage per line of code — we already have ~30 health checks; this turns them into a passive monitoring system.

---

## Tier 2 — Medium impact (within 2-3 weeks)

### #5 — `cortextos status --json` deep-health view

**Problem.** Today `cortextos status` shows running/crashed/halted + uptime + PID. Not enough to build #2, #4, or #11 against without each rolling their own state reader.

**Scope.** Extend `status --json` payload per agent with:
- `last_heartbeat_age_seconds`
- `last_heartbeat_task` (the agent's free-text "current task" field)
- `last_inbox_message_age_seconds`
- `crash_count_today`
- `max_crashes_per_day`
- `crashes_remaining` (derived: max - today)
- `last_restart_reason` (parsed from restarts.log tail)
- `last_spawn_failure_age_seconds` (from `.spawn-failure-history.json`, null if none)

**Files.**
- `src/cli/status.ts` (extend the JSON formatter)
- `src/daemon/agent-manager.ts` `getStatus()` if backing data isn't already there

**Acceptance.**
- `cortextos status --json` returns the extended payload
- Existing text-mode `status` unchanged (don't break ops habits)
- Dashboard widget (#11) and watchers (#2, #4) consume this — no duplicate state-reading code

**Why this matters.** Foundation for several Tier 1/3 items. Build first if doing more than one of #2/#4/#11.

---

### #6 — Self-healing scripts installed by default

**Problem.** `scripts/self-healing/{watchdog,agent-recover,usage-monitor,compact-boundary-watcher}.sh` are excellent stop-gaps but require a manual launchctl-load step that nobody does. `launchctl list | grep cortextos` on this machine was empty.

**Scope.** Fold script installation into `cortextos install`:
- Copy scripts to `~/.cortextos/<instance>/scripts/`
- Render plist templates with the user's $USER/$HOME/$INSTANCE
- `launchctl load` each plist
- Print a summary table at the end of `cortextos install`

Add `--skip-self-healing` flag for users who want manual control.

**Files.**
- `src/cli/install.ts` (or wherever install lives)
- New: `src/cli/install-self-healing.ts` (extract for testability)

**Acceptance.**
- Fresh `cortextos install` → `launchctl list | grep cortextos` shows 4 scripts loaded
- Re-running `install` is idempotent (don't double-load)
- `--skip-self-healing` skips the step
- Uninstall (`cortextos uninstall`) unloads them

**Why this matters.** Closes the "great scripts that nobody uses" gap. Most operators miss the README step.

---

### #7 — Crash-budget reset on planned-restart

**Problem.** `.crash_count_today` only resets at midnight. An agent that crashed 9 times before a fix lands is one crash away from `halted` for the rest of the day. A successful planned restart should reset the counter to 0 — that's "earned trust".

**Scope.** When `restarts.log` writes `SELF-RESTART`, `HARD-RESTART`, or `user-restart` AND the agent reaches `running` status afterwards, reset `.crash_count_today` to 0 (keep the day prefix for the audit trail).

**Files.**
- `src/daemon/agent-process.ts` — in the `notifyStatusChange` path when status transitions `crashed → running` after a planned-restart marker
- Add: `private lastRestartKind: 'CRASH' | 'SPAWN-FAIL' | 'PLANNED' | null`

**Acceptance.**
- Unit test: agent crashes 9 times (crashCount=9), planned-restart succeeds, next crash counts as #1 not #10
- Unit test: pure CRASH/SPAWN-FAIL cycle does NOT reset (existing budget behavior preserved)
- Audit trail: restarts.log records the reset event so we can see it

**Why this matters.** Today, recovering from a bad day means waiting for midnight or `rm .crash_count_today`. Neither is right.

---

### #8 — node_modules-mtime warning on agent start

**Problem.** Daemon's loaded node-pty binding can be silently invalidated by `npm install` / `pnpm install`. PRs #37 + #40 prevent the *failure mode*, but if some future change introduces a similar staleness, we won't know.

**Scope.** On every `AgentProcess.start()`, `stat(node_modules)` and compare mtime to `daemon.sessionStart`. If newer: log CRITICAL warning (don't block, don't auto-restart — purely telemetry).

**Files.**
- `src/daemon/agent-process.ts:start()` — single stat call at the top

**Acceptance.**
- Unit test: mock `statSync` to return newer mtime → warning logged
- Mock to return older mtime → no warning
- Stat failure → no warning (graceful)

**Why this matters.** Closes the residual case where PR #40's auto-chmod missed something. Cheap telemetry; one line of value.

---

## Tier 3 — Long-term (1-2 months)

### #9 — Agent-supervisor IPC heartbeat

**Problem.** Today's heartbeat is agent → file → daemon polls. The agent can be wedged inside a tool call and the file goes stale; #2 catches this from the daemon side. A daemon-pushed IPC heartbeat would close the symmetry: daemon expects the agent to respond to a ping within N seconds.

**Scope.** Daemon's IPC server sends a `ping` to each agent every 60s. Agent's IPC handler responds `pong`. No pong in 2 consecutive pings → escalate. Note: requires the agent's IPC server to be alive at the Node level, separate from Claude's PTY status, so it catches a wider class of hangs.

**Acceptance.** TBD when scoped — depends on choosing whether to add an IPC server inside each agent's Node host (heavier) or piggyback the existing inject/status IPC (lighter).

**Why this matters.** Catches PTY-alive-but-Claude-wedged. Lower priority than #2 because #2 covers the same ground with much less code.

---

### #10 — macOS quarantine xattr check

**Problem.** Some Gatekeeper scenarios set `com.apple.quarantine` on downloaded binaries, which can block exec even with the right mode bits. Not seen in production but theoretically possible for spawn-helper prebuild.

**Scope.** Doctor (and `node-pty-perms.ts` helper) should detect quarantine xattr on spawn-helper and `xattr -d com.apple.quarantine` it.

**Files.**
- `src/utils/node-pty-perms.ts` — add xattr check + remove
- `src/cli/doctor.ts` — surface as a check

**Acceptance.** Manual repro: `xattr -w com.apple.quarantine '0001;...' spawn-helper`, run daemon → daemon clears xattr at startup. Add test if xattr can be reliably set in a sandbox.

**Why this matters.** Belt-and-suspenders for the auto-chmod layer. Real-world incidence is low; deferral is fine.

---

### #11 — Fleet-health dashboard widget

**Problem.** Today the operator finds out about fleet problems by manually running `cortextos status` or by seeing a Telegram alert. There's no glanceable surface.

**Scope.** Dashboard panel with:
- Per-agent green/yellow/red traffic light (green = healthy, yellow = stale heartbeat or recent restart, red = crashed/halted)
- Last-N restarts.log entries per agent (scrolling)
- Click-to-`cortextos restart <agent>` button
- Last spawn-failure-history event (if any in last 24h)
- Dashboard rebuild on cron failure events (#1 wiring)

Data source: `cortextos status --json` (#5) + restarts.log tail + `.spawn-failure-history.json`.

**Files.**
- `dashboard/src/app/fleet-health/page.tsx`
- `dashboard/src/components/fleet-health/...`
- `dashboard/src/app/api/fleet/status/route.ts` (calls IPC, returns #5 payload)

**Acceptance.** TBD on scope — at minimum: page loads, shows current fleet state, refreshes every 30s.

**Why this matters.** Operator surface that would have made May 14 obvious within minutes of the first failure. Lower priority than the alerting work because Telegram already covers the urgent case once #1/#2/#4 land.

---

## How to use this plan

- Pick by number, not order. Each item is self-contained.
- Items #1, #2, #3, #4 are the highest-leverage set if you do nothing else.
- Item #5 (status JSON) is a foundation — build it first if you intend to do more than one of #2/#4/#11.
- Don't try to do all of Tier 3 — pick the ones that solve current pain, defer the rest.

## What's already done (cross-references)

- **PR #37** (merged 2026-05-14) — spawn-failure retry symmetry + cross-agent storm detector
- **PR #40** (open as of 2026-05-15) — auto-chmod spawn-helper at startup + postinstall
- **Post-mortem** — `docs_sb/issues/07-posix-spawnp-after-pnpm-reinstall.md`
