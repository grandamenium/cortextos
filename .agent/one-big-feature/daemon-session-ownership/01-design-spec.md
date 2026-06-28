# Design Spec — Daemon Agent Session-Ownership / Handoff Model

**Status:** proposed (design-level, for Josh approval). No code in this doc.
**Repo:** cortextos framework (`~/code/cortextos/src/daemon/`, `src/pty/`, `src/utils/`).
**Author:** Architect, 2026-06-25. Source-grounded; every claim cites `file:line`.
**Supersedes the approach in:** commit `3d44aec` (failed) — see §6.

---

## 0. TL;DR

The fleet restart-loop is a **session-id ownership** bug, not a marker-race bug. On 2026-06-08, PR #20 (`f5d69e4`) pinned every agent to a **fixed, deterministic Claude session id** and began passing it explicitly as `--session-id <id>` (fresh) / `--resume <id>` (continue). That single reused token is a lock. The daemon's restart path (`stop()` → `start()`) does **not** guarantee the previous holder of that token is dead before it spawns the next one: `AgentProcess.stop()` returns after a bounded 15 s race **with no SIGKILL escalation and no confirmation the OS process actually exited** (`agent-process.ts:289-291`). When the old `claude` is still alive, the new spawn hits `Error: Session ID <uuid> is already in use` → exit 1 → crash recovery → respawn with the **same** id → collide again → loop to HALTED. `pm2 restart` doesn't help because orphaned `claude` children survive daemon death and nothing reaps them on boot.

Fix the **ownership model**, not the markers: (1) stop reusing a fixed id on the fresh path — mint a fresh random session id per fresh spawn, persisted in per-agent state; (2) make teardown *prove death* (SIGKILL escalation + pid-tree poll) before any reuse on the resume path; (3) reap orphaned `claude` processes on daemon boot; (4) make the context-watchdog trigger **stateless / self-clearing** so it cannot fire at low context off a stale in-memory deadline.

---

## 1. Root cause (one paragraph, sourced)

Each agent resumes under a **fixed** id from `getDeterministicAgentSessionId(name, org)` (`agent-session-isolation.ts:44-55`), and `AgentPTY.buildClaudeArgs()` passes it as `--resume <id>` in continue mode or `--session-id <id>` in fresh mode (`agent-pty.ts:230-236`). Because the id never changes across restarts, **every** spawn of agent X asserts ownership of the *same* token, and Claude Code enforces single-live-owner per session id (the `already in use` error). The daemon's release path is not airtight: `AgentProcess.stop()` writes `/exit`, waits 5 s, calls `pty.kill()` only `if (pty.isAlive())`, then does `await Promise.race([exitPromise, sleep(15000)])` and returns regardless (`agent-process.ts:262-291`). There is **no SIGKILL escalation and no post-kill liveness check** — if the child ignores SIGHUP/`/exit` (wedged on a tool call, MCP child, or compaction), `stop()` resolves `status='stopped'` while the process is still alive and still holds the id. `start()` then spawns a new `claude` with the identical id → exit 1, which `handleExit()` classifies as a crash (it matches neither the image-poison nor rate-limit signatures, `agent-process.ts:669-696`) → exponential-backoff respawn (`:746-750`) → same collision → climbs to `HALTED` at `maxCrashesPerDay` (`:727-733`). The involuntary trigger that drives these restarts is itself unreliable: `FastChecker` Tier-3 fires `forceContextRestart()` purely on the in-memory deadline `ctxHandoffDeadlineAt` **without re-reading the live context %** (`fast-checker.ts:1274-1279`), and the "new session → clear stale deadline" guard keys off `context_status.json.session_id` (`fast-checker.ts:1246-1254`) which, because the session id is deterministic and stable, **does not change across a clean restart** — so a deadline armed in a high-context session survives into a fresh low-context session and fires a spurious restart at 0–62%.

---

## 2. How it worked before (Part 1 — historical audit)

### 2.1 Pre-`f5d69e4` (before 2026-06-08): clean boundary came for free
`buildClaudeArgs()` before the isolation PR (`git show f5d69e4^:src/pty/agent-pty.ts`):

```
if (mode === 'continue') { args.push('--continue'); }   // no id
// fresh: no session flag at all
args.push('--dangerously-skip-permissions');
```

- **Fresh start** passed *no* session flag → Claude Code minted a **brand-new random session id every boot**. Two processes could never contend for an id because a fresh boot never asserted a pre-existing one.
- **Continue** used bare `--continue` → reattach to the *newest* conversation file in the cwd's project dir. It asserts no explicit id either.

The clean session boundary was **implicit**: fresh = always-unique id; continue = reattach-newest. `Session ID already in use` was structurally impossible because the daemon never *named* a reused id.

### 2.2 What `f5d69e4` (PR #20, "kill wrong-brain resume bug") changed
The real bug it fixed: two agents sharing a `working_directory` would `--continue` into **each other's** brain (cwd-keyed project history is shared). The fix pinned each agent to a deterministic per-agent id so resume always returns to *its own* conversation regardless of cwd (`agent-process.ts:788-792`, `agent-pty.ts:230-236`), and added a working-directory-collision policy (`agent-session-isolation.ts:135-178`). **Correct goal, but it traded the implicit clean-boundary for an explicit, reused lock token whose release is now the daemon's job** — a job `stop()` does not reliably finish (§1).

### 2.3 Where gstack fits (and why removing it *exposed* the latent bug)
gstack's `/context-save`-before-compact was the **agent-cooperative** reset path: the agent wrote a handoff doc and triggered a clean hard-restart *before* context filled. While that path was healthy, agents rarely reached the daemon's **involuntary** context-watchdog force-restart (`forceContextRestart()` → `sessionRefresh()` → `stop()`+`start()`, `fast-checker.ts:1356-1413`). When gstack was removed (~2026-06-22), the cooperative path vanished and the **only** remaining reset became the involuntary force-restart — which is exactly the path that (a) reuses the fixed id and (b) fires off stale in-memory deadlines. gstack removal did not *create* the lock bug (`f5d69e4` did); it removed the shock-absorber that kept the fleet away from the broken path, turning a latent defect into a fleet-wide loop. **Implication: context management must not depend on a removable plugin — the daemon's own reset path must be correct.**

---

## 3. Current mechanic (Part 2 — precise control flow)

**Session id assignment:** `getDeterministicAgentSessionId()` — SHA-1(namespace ∥ `org:name`) → UUIDv5, stable forever (`agent-session-isolation.ts:44-55`).

**Spawn flags:** `AgentPTY.buildClaudeArgs()` — `--resume <id>` (continue) or `--session-id <id>` (fresh) (`agent-pty.ts:230-236`). Same `<id>` both ways.

**Continue-vs-fresh decision:** `AgentProcess.shouldContinue()` (`agent-process.ts:753-792`):
1. `.force-fresh` exists → consume (unlink) → **fresh** (`:761-769`).
2. else claude runtime → `findClaudeSessionFile(id) !== null` → **continue** (`:791-792`); the session file is `~/.claude/projects/<escaped-cwd>/<id>.jsonl` (`agent-session-isolation.ts:75-89`).

**Marker consumption:** `.handoff-doc-path` consumed once in `consumeHandoffBlock()` (`agent-process.ts:887-898`); `.force-fresh` written by `armForceFresh()` (`:586-595`), by `hardRestart()` (`bus/system.ts`), and pre-armed in the watchdog (`fast-checker.ts:1346`).

**Spawn / exit:** `AgentPTY.spawn()` lazy-loads node-pty, spawns `claude` directly (`agent-pty.ts:150-156`); `onExit` nulls the pty and calls the handler (`:166-172`). `AgentProcess` wraps exit with a generation guard (`agent-process.ts:165-179`) and routes to `handleExit()` (`:597-751`).

**Exit-1 handling:** `handleExit()` — not daemon-stop, not `stopRequested`, not image-poison, not rate-limit → **counted as a crash** → backoff respawn (`agent-process.ts:736-750`) → `HALTED` at the daily/window cap (`:710-733`). `already in use` matches none of the recoverable signatures, so it always lands in the crash path.

**Stop / lock-release gap:** `AgentProcess.stop()` (`agent-process.ts:219-301`) — captures+nulls pty, `/exit`+5 s, `pty.kill()` **only if alive** (`:275-281`), `await Promise.race([exitPromise, sleep(15000)])` (`:289-291`), then returns. `AgentPTY.kill()` sends node-pty's default signal once (`agent-pty.ts:302-309`). **No SIGKILL escalation; no `process.kill(pid,0)` confirmation that the OS process (and its child tree: MCP servers, bash-tool children) actually died before the id is reused.**

**Double-start surface:** `startAgent()` early-returns into `pendingRestarts` when the agent is still in the registry (`agent-manager.ts:282-310`); `stopAgent()` honors the queued restart by firing a *second* `startAgent` (`:922-933`). `restartAgent = stopAgent + startAgent` (`:947-956`). These overlap windows are where two spawns can race the same id.

**Watchdog trigger state:** Tier-2 arms `ctxHandoffDeadlineAt = now + 5min` (`fast-checker.ts:1330-1331`); Tier-3 fires on `now > ctxHandoffDeadlineAt` **without re-checking live %** (`:1274-1279`). The stale-deadline reset depends on `context_status.json.session_id` changing (`:1246-1254`), but that id is the **deterministic, unchanging** one (written through from the statusLine hook, `hook-context-status.ts:73`) — so the reset is unreliable across a clean restart. `FastChecker` is owned by the `AgentManager` registry, **not** recreated by `sessionRefresh()` (which only does `AgentProcess.stop()`+`start()`, `agent-process.ts:313-335`) — so its in-memory deadline persists across a session refresh.

**Why `pm2 restart` doesn't clear it:** node-pty `claude` children orphan to pid 1 if the daemon dies before a clean `stopAll()`; nothing on boot kills strays (grep: no `pkill`/`killall claude` anywhere in `src/`). `discoverAndStart()` → `startAgent()` → spawn with the same deterministic id → collide with the surviving orphan. The lock-holder is outside the daemon's restart lifecycle.

---

## 4. Invariants the design must guarantee

- **I1 — Single live owner:** at most one live `claude` process may hold a given session id at any instant.
- **I2 — Release-before-reuse:** a session id is reused only after the prior holder's OS process (and PTY child tree) is *confirmed* dead and its session lock released.
- **I3 — No fresh-path reuse:** a *fresh* start never reuses an id that any live/zombie process could still hold.
- **I4 — Stateless trigger:** an involuntary restart fires only on a condition that is *currently true*, recomputed from live state at fire time — never off a stored "fire later" intent.
- **I5 — Boot cleanliness:** on daemon start, no orphaned `claude` from a prior daemon may hold an id the daemon is about to assign.
- **I6 — Isolation preserved:** the per-agent "own brain" guarantee from `f5d69e4` (no cross-agent / cwd-shared resume) must survive any change.

---

## 5. Proposed ownership model

### 5.1 Single-writer session-id record (replaces the deterministic-id-as-lock)
Introduce a per-agent **session record** `state/<agent>/session.json`: `{ "sessionId": <uuid>, "mintedAt": <iso>, "mode": "fresh|resume", "pid": <n>|null }`, written **only** by `AgentProcess` at spawn time (single writer = the lifecycle owner).

- **Fresh spawn** (force-restart, handoff, `.force-fresh`, first boot): mint a **new random uuid**, persist it, spawn `--session-id <newId>`. → satisfies **I3**: a fresh start can never collide, restoring the pre-`f5d69e4` safety *without* losing isolation (the id is the agent's own, persisted, not cwd-derived).
- **Resume spawn** (config-reload `sessionRefresh`, session-time-cap rollover, normal `--continue` boot): read `sessionId` from the record, spawn `--resume <sessionId>`. Reuse is intentional here, so it is gated by **I2** (§5.2).
- `getDeterministicAgentSessionId()` is retained **only** as the migration seed for an agent that has no `session.json` yet (first boot after upgrade), then never again. Drop it from `buildClaudeArgs()` — the id comes from the record.

This collapses the fleet-loop trigger: the involuntary context force-restart always takes the **fresh** path (`.force-fresh` is pre-armed, `fast-checker.ts:1341-1347`), so post-fix it mints a new id and **cannot** hit `already in use`. The high-frequency failure mode is gone by construction, not by winning a race.

### 5.2 Teardown that proves death (the resume-path guarantee)
Rewrite the kill ladder so `stop()` cannot return while the process lives:

1. graceful: `/exit` (Claude) / Ctrl-D (Hermes) / `kill` (Codex) as today;
2. wait short grace; if `process.kill(pid, 0)` still succeeds → **SIGTERM**;
3. re-poll; if still alive after grace → **SIGKILL** to the **process group** (reap MCP/bash children, not just the pty leader);
4. **block until `process.kill(pid,0)` throws ESRCH** (confirmed dead) or a hard ceiling elapses;
5. on ceiling-exceeded: do **not** silently proceed — mark the agent `wedged`, emit a Telegram + `restarts.log` `WEDGED` line, and refuse the id-reuse start (a stuck process is an operator event, not something to paper over with another colliding spawn).

`AgentPTY.kill()` (`agent-pty.ts:302-309`) gains the escalation + group-kill; `AgentProcess.stop()` (`agent-process.ts:219-301`) replaces the fixed 15 s race (`:289-291`) with the confirm-death loop. This is what makes the *resume* path safe (**I2**) and removes the "stop returned but process lived" window entirely.

### 5.3 Boot-time orphan reap (I5)
Before `discoverAndStart()` (`agent-manager.ts:114-147`), scan for stray `claude` processes belonging to managed agents and SIGKILL them. Identify by matching `CTX_AGENT_NAME=<managed>` in the process environment, or `--session-id`/`--resume <id>` on the command line against the agents' `session.json` ids. Log each reap. Closes the pm2-bounce path so a fresh daemon never inherits a live owner of an id it is about to assign.

### 5.4 Stateless / self-clearing watchdog trigger (I4)
Remove the stored-deadline-as-trigger. On each poll, `checkContextStatus()` recomputes from live `context_status.json`:

- Tier-3 force-restart fires **only if** the live `effectivePct` read *this cycle* is still `>= handoff` **and** a handoff prompt was injected `> 5 min` ago and not yet acted on. Re-read pct at fire time; if pct dropped below threshold (agent self-handed-off, or the hook reset it), **abort and clear** the pending state. This directly fixes `fast-checker.ts:1274-1279` firing at 0–62%.
- Drop reliance on `session_id` change for staleness (`:1246-1254`) — it is unreliable under any stable-id scheme. Instead, treat the pending handoff as a function of `(handoff-injected-at, current-pct)` only; both are re-read each cycle, so nothing stale can persist. (If the rotating-id model in §5.1 lands, `session_id` *does* change on every fresh restart and becomes a *valid* secondary reset signal — but the design must not *depend* on it.)
- Recommended: move the per-session ctx flags out of `FastChecker` instance memory (which survives `sessionRefresh`) or have `sessionRefresh()` reset them, so a refreshed AgentProcess never inherits a prior session's trigger state.

---

## 6. Why `3d44aec` missed (explicit contrast)

`3d44aec` changed `pendingRestarts: Set → Map<name,{forceFresh}>`, re-armed `.force-fresh` before honoring a queued restart, and made `stopAgent()` return a bool so `restartAgent()` skips a double-start (diff confirmed via `git show 3d44aec`). Its thesis: the loop is a **marker race** — a queued second `startAgent` consumes `.force-fresh` first, so the "real" start falls back to `--continue` at full context.

It missed because it operated **one layer above the actual lock**:

- It guarantees the second start *also goes fresh*. But **a fresh start still asserts the same deterministic `--session-id`** (`agent-pty.ts:235`). If the prior `claude` still holds that id, the fresh start hits `already in use` and exits 1 **exactly as before**. Fresh-vs-continue is orthogonal to id contention.
- It never touches `stop()`'s return-before-death window (`agent-process.ts:289-291`) — the actual source of two live owners (**I2** violation).
- It never touches the watchdog firing at low context off a stale deadline (`fast-checker.ts:1274-1279`) — so spurious restarts (the *trigger* of the collisions) keep coming (**I4** violation).
- It never reaps boot orphans (**I5**), so `pm2 restart` still cannot recover.

In short: it tuned *which conversation the new process loads* and never addressed *whether two processes own one id*. The `already-in-use` exit is an ownership/lifecycle failure; a `pendingRestarts` Map cannot fix a lock the code reuses while the prior holder is alive.

---

## 7. Test plan (offline, no live-fleet thrash)

All tests run against a throwaway `CTX_ROOT` with a stub "claude" binary; **scrub all six `CTX_*` env vars first** (phantom-failure guard, per fleet memory).

- **T1 — id-reuse collision repro (RED first):** stub `claude` that (a) on `--session-id`/`--resume <id>` writes a lockfile and **sleeps** (simulating a wedged holder), (b) a second invocation with the same id exits 1 + prints `Session ID <id> is already in use`. Drive `stop()`+`start()` where the first holder ignores `/exit`. Assert: pre-fix → second spawn exits 1; post-fix(§5.2) → `stop()` SIGKILLs and *confirms death* before reuse, no exit 1.
- **T2 — fresh-path never reuses (I3):** force-restart path with `.force-fresh` armed; assert the new spawn's `--session-id` differs from the previous session record's id and `session.json` was rewritten.
- **T3 — multi-overlapping restart (the core race):** fire `restartAgent` + a queued `startAgent` + a watchdog `forceContextRestart` interleaved (simulate via direct calls + fake timers). Assert: exactly one live pid at the end; zero `already in use`; final session is fresh; no `BUG-011 REGRESSION CHECK` warning. This is the test `3d44aec` should have had at the ownership layer.
- **T4 — stateless trigger (I4):** arm a handoff at 85%, then feed `context_status.json` at 40% on the next cycle; assert Tier-3 does **not** fire and the pending state clears. Second case: 85% persists > 5 min with no agent action → asserts it *does* fire. Pure logic test on `checkContextStatus()` with injected clock + status file.
- **T5 — boot orphan reap (I5):** seed a fake stray process record matching a managed agent's id; assert the reaper kills it before `discoverAndStart` spawns; assert no collision on first spawn.
- **T6 — confirm-death ceiling (I2 failure mode):** holder that ignores SIGTERM **and** SIGKILL (uninterruptible stub); assert `stop()` does not silently proceed, marks `wedged`, emits the alert, and does **not** start a colliding process.
- **T7 — isolation regression (I6):** keep/extend `agent-manager-session-isolation.test.ts` and `agent-session-isolation` cwd-collision tests — two agents, shared cwd → still rejected; resume still returns each agent's own brain.

Verifiable entirely with fake timers + stub binary; the live fleet is touched only by the final single gated daemon rebuild.

---

## 8. Files an implementation would touch

| File | Change |
|---|---|
| `src/utils/agent-session-isolation.ts` | add `readSessionRecord` / `writeSessionRecord` / `mintSessionId`; keep `getDeterministicAgentSessionId` as first-boot migration seed only. |
| `src/pty/agent-pty.ts` | `buildClaudeArgs()` reads id from session record (fresh=mint+persist, resume=read); `kill()` gains SIGTERM→SIGKILL escalation + process-group reap. |
| `src/daemon/agent-process.ts` | `stop()` confirm-death loop replaces the 15 s race (`:289-291`); `shouldContinue()` consults the session record; `sessionRefresh()` resets per-session watchdog state; mint/persist on fresh. |
| `src/daemon/agent-manager.ts` | boot-time orphan reaper before `discoverAndStart`; serialize stop→confirmed-death→start so the `pendingRestarts` double-start window closes by construction (then retire the Set/Map workaround). |
| `src/daemon/fast-checker.ts` | Tier-3 re-reads live pct at fire time (`:1274-1279`); drop dependence on `session_id`-change reset (`:1246-1254`); self-clearing pending-handoff state. |
| `src/daemon/index.ts` / startup | wire the reaper; `WEDGED` status + alert plumbing. |
| `tests/unit/daemon/*` | T1–T7 above; extend existing `agent-manager-session-isolation.test.ts`. |

---

## 9. Migration & rollback; risk to the live 11-agent fleet

- **Migration:** first boot after upgrade finds no `session.json` → seed it from `getDeterministicAgentSessionId` (preserves the *current* resume continuity exactly once), then rotate on subsequent fresh starts. No agent loses its in-flight conversation on upgrade.
- **Rollback:** the change is daemon-internal (no schema, no bus protocol, no Telegram contract). Revert = redeploy prior `dist` + one daemon restart. `session.json` files are inert to the old code (it ignores them and falls back to the deterministic id). Safe.
- **Sequencing:** build via codexer → adversarial review → **one** clean daemon rebuild + restart, kill-switch gated (Josh approval — this is a framework change touching every agent's lifecycle). Do **not** land during an active extraction (in-memory phase jobs die on daemon restart, per fleet rule).
- **Risks:**
  - *Over-aggressive reaper kills a legitimate process* → scope strictly to env `CTX_AGENT_NAME ∈ managed` **and** id-match; dry-run log-only mode first boot, enforce second. Mitigation: T5 + a `--reap-dry-run` flag.
  - *SIGKILL escalation truncates a mid-flight tool write* → only escalates after graceful `/exit` + grace already elapsed (same posture as today, just with confirmation); acceptable because the alternative is a wedged holder looping the fleet.
  - *`wedged` state strands an agent instead of looping it* → intended: a strand with one Telegram alert is strictly better than a HALTED crash-loop, and is operator-visible. Auto-unhalt/midnight reset already exists (`ea34612`) and can clear it.
  - *Claude releases its session lock on SIGHUP but leaves a stale lockfile on SIGKILL* → **open question O1** below; T1/T6 must pin the real release semantics before shipping.

---

## 10. Open questions for Josh

- **O1 (highest):** Is Claude Code's `Session ID already in use` enforced by a **live-process** check or a **lockfile**? If lockfile-based, a SIGKILLed holder can leave a *stale* lock (no process alive, id still "in use") — then §5.2 alone is insufficient and the reaper/teardown must also delete the stale lock artifact. Must be determined empirically (T1/T6) before implementation; changes the fix surface.
- **O2:** Accept the **rotating-id** model (§5.1, drop deterministic id as the spawn token), or keep the deterministic id and rely solely on teardown+reap (§5.2/5.3)? Rotating is structurally safer (eliminates fresh-path contention by construction) but changes the resume-continuity reasoning and the statusLine `session_id` semantics. Recommendation: **rotating + teardown both** (defense in depth).
- **O3:** On a confirmed-`wedged` agent, **strand-and-alert** (recommended) vs. force a fresh id and start anyway (risks orphan)? Stranding is safer but means an agent can sit dead until an operator/auto-unhalt acts.
- **O4:** Should the boot reaper run **fleet-wide** (all managed agents across orgs) or only the daemon's startup org? Multi-org installs (`agent-manager.ts:1254-1289`) argue for fleet-wide; confirm blast radius is acceptable.
- **O5:** Is the cooperative gstack-style `/context-save` path being permanently retired in favor of the daemon-native reset, or restored as the primary with the daemon as fallback? This spec hardens the daemon path regardless, but the answer sets whether the watchdog is the common path (must be bulletproof) or the rare path (still must be correct, lower tuning pressure).
