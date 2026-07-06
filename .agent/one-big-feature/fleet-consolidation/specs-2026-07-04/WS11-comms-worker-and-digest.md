# WS11 — Comms-Worker Architecture + Orchestrator Digest

> Status: SPEC (planning only, no code). Author: Architect. Date: 2026-07-04.
> Fork: `/Users/joshweiss/code/cortextos` (origin `clearworks-ai`, upstream `grandamenium`).
> Grounded against the LIVE fork. Batch A/B/C assumed NOT landed unless a file is cited below.

---

## 1. GOAL

Make frank2's autonomous comms loop trustworthy and legible on Josh's phone:

1. **Architecture ruling** — decide whether frank2 should keep spawning a fresh short-lived worker every 15m for comms-check, or run it inline / as one long-lived worker. Ground the decision in the worker-leak and false-crash history, not aesthetics.
2. **Kill false crashes at the source** — a normal worker exit must never be classified as `type=crash` and must never emit "🚨 CRASH … died unexpectedly. Crashes today: N." ALSO in scope: autonomous crons must not stall for 30 minutes on an interactive permission prompt they can never answer ("Permission request TIMED OUT (auto-denied): Bash").
3. **Orchestrator digest** — rebuild frank2's morning/evening brief into ONE COMPACT BLOCK PER AGENT (emoji + name + 2-4 concrete overnight-output bullets) under a HEADER (tasks-done / approvals / blocked / HARNESS USAGE SPLIT Claude% · Codex% · OpenCode%). Reslice frank2's existing heartbeat/task/event data by AGENT. Also fix today's "no morning brief on Saturday" and the silent-failure blindness (surface `errored>0`, not just `generated=0`).

---

## 2. GROUNDED CURRENT STATE

### 2.1 How a comms-check actually runs (verified)

- `config.json` cron `comms-check` (interval `15m`, enabled) prompt does NOT run the check inline. It runs:
  `cortextos spawn-worker "comms-check-$(date +%s)" --dir "$(pwd)" --parent frank2 --prompt "Read .claude/skills/comms-check-worker/SKILL.md …"` (config.json line ~40; `fleet-reconcile` is the same shape at line 46, model `claude-haiku-4-5`).
- The cron prompt is injected into frank2's MAIN PTY via `AgentManager.startAgentCronScheduler → onFire → injectAgent()` (`src/daemon/agent-manager.ts:1205-1217`). So frank2's main session is what issues the `spawn-worker` call; the actual triage runs in a separate ephemeral Claude Code PTY.
- The worker PTY is created by `WorkerProcess.spawn()` (`src/daemon/worker-process.ts:49-84`): it writes a `.is-worker` marker (`worker-process.ts:58`), runs with `AgentPTY` which sets `CTX_WORKER=1` when `env.worker` (`src/pty/agent-pty.ts:80-82`) and passes `--dangerously-skip-permissions` (`agent-pty.ts:258`), and self-reaps after `MAX_WORKER_LIFETIME_MS`.
- Worker self-terminates at the end of the SKILL: `cortextos terminate-worker "$CTX_AGENT_NAME"` (`comms-check-worker/SKILL.md` Step 6, the #25 worker-leak fix).

### 2.2 False-crash mechanism (verified, and PARTIALLY already fixed)

- The alert is emitted by the **SessionEnd hook** `src/hooks/hook-crash-alert.ts`, message string at line 457-458: `🚨 CRASH: ${agentName} died unexpectedly.` + ` Crashes today: ${crashCount}.`
- The hook classifies an exit as `crash` only when NO restart marker matched (`classifyFromMarkers` returns `{endType:'crash'}` as the fallthrough, line 258) and no rate-limit signature is in stdout (line 319-325).
- Worker suppression is layered THREE ways: `CTX_WORKER` env OR name-suffix `/-\d{10,}$/` early-return at **line 279** (no log, no alert); `.is-worker` marker → log-to-crashes.log-then-return at **line 284/381**.
- **Evidence the FPs came from an OLD build:** every `type=crash reason=none` line in `~/.cortextos/cortextos1/logs/comms-check-*/crashes.log` is dated ≤ 2026-07-03 22:31. The dist hook was rebuilt **Jul 4 10:58** (`dist/hooks/hook-crash-alert.js`, newer than src `Jul 3 21:21`) and DOES contain the `CTX_WORKER || /-\d{10,}$/` guard (verified via grep on dist). So the worker-suffix early-return is now deployed. This WS must (a) VERIFY no new FP lines appear post-rebuild, and (b) close the residual gaps below rather than re-fix what already shipped.
- **Residual gap A — the name-suffix guard is fragile.** It depends on the worker being named `<base>-<10+digit-epoch>`. `fleet-reconcile-$(date +%s)` and `comms-check-$(date +%s)` satisfy it today, but any future worker named without a 10-digit epoch suffix (and spawned before the daemon reload that sets `CTX_WORKER`) would fall through to `type=crash`. The `.is-worker` marker is the robust signal; the suffix regex is a fallback that should never be the ONLY thing standing between a normal exit and a 🚨.
- **Residual gap B — a non-zero worker exit code is still a "crash" candidate for the marker logic even though it is a worker.** `WorkerProcess` sets `status='failed'` on non-zero exit (`worker-process.ts:67`) but the crash hook does not read exit code; it relies purely on markers + worker-detection. A worker that legitimately fails (e.g. transient gws timeout) should be logged as a worker failure, never paged as an agent crash — the current code gets this right ONLY because of the worker-detection early return, i.e. it is correct but load-bearing on the same fragile guard as gap A.

### 2.3 Permission-timeout auto-deny (verified — a real, separate bug)

- `src/hooks/hook-permission-telegram.ts` is a **blocking PermissionRequest hook**. On any tool that needs approval it sends a Telegram with Approve/Deny buttons and BLOCKS up to `TIMEOUT_MS = 1800*1000` (30 min, line 81), then sends `Permission request TIMED OUT (auto-denied): ${tool_name}` (line 101) and denies (line 106).
- Workers run `--dangerously-skip-permissions` (`agent-pty.ts:258`), so **worker** sessions do NOT hit this. The stall happens in the **MAIN frank2 PTY** when a cron prompt injected inline (heartbeat, check-approvals, midday-blockers, evening-wrap, the many Sonnet-subagent crons, etc.) issues a Bash/tool call that trips a permission rule. The main agent is interactive-by-design (it must ask Josh for genuinely sensitive actions), so it CANNOT be blanket `--skip-permissions`. Result: an autonomous cron blocks the entire main session for 30 min, then auto-denies and the cron silently produces nothing.
- There is a partial mitigation already: `isClaudeDirOperation` auto-approves `.claude/` writes (line 43). There is no notion of "this tool call originated from an autonomous cron, so don't wait 30 min for a human."

### 2.4 Brief / digest current state (verified)

- **`morning-brief`** cron `3 8 * * 1-5` (config.json:57) — **weekday-only**. This is why there was no brief on Sat 2026-07-04. It runs `scripts/morning-brief.sh` — a programmatic, NO-AI hook that pulls the briefs repo, runs `publisher/build_brief_feed.py` + `publisher/build_dashboard.py`, and Telegrams the dashboard URL. It does NOT reslice agent work — it just rebuilds the dashboard. The header says "DO NOT replace with a custom AI agent prompt."
- **`evening-wrap`** cron `2 17 * * 1-5` (also weekday-only) — an AI prompt that dispatches overnight work AND rebuilds the same dashboard, sends URL.
- **`morning-review` / `evening-review` SKILLs** (`.claude/skills/`) are the richer AI workflows. `morning-review` Phase 0 already collects exactly the raw material the digest needs: `read-all-heartbeats`, `list-tasks --status completed`, `list-tasks --status in_progress`, per-agent completions. But its output (Phase 3) is sliced by TASK-CATEGORY (Overnight Work / System Health / Today's Focus), NOT by agent, and it is not what the weekday cron actually fires (the cron fires the .sh, not the SKILL).
- **`daily-ops-dashboard`** cron `5 15 * * *` (DAILY) rebuilds a 6-tab dashboard in the `briefs` repo via `build_dashboard.py`. This is the publish surface the digest should feed (a dashboard tab), per the standing rule "briefs go to the website, not Telegram text."
- **Silent-failure blindness:** the trending/wiki crons (and today's Anthropic-credit outage) report success on `generated=0` and never surface `errored>0`. `morning-brief.sh` only fails loud if the dashboard URL build returns non-http; it does not distinguish "0 items because nothing happened" from "0 items because every source errored."

### 2.5 Harness-usage-split data source (WS8 dependency — NOT yet available)

- WS8 (model-routing / usage telemetry) has **no spec file** in `specs-2026-07-04/` and no usage/token/cost tracking exists in `src/bus/` (grep of `src/bus/` found `metrics.ts`, `heartbeat.ts`, `task.ts` — none carry per-call model or token counts).
- What DOES exist for a fallback split: every agent's `config.json` carries a `model` field. Live enabled agents map to harnesses as:
  - Claude: frank2/maven/muse (`claude-sonnet-5`), larry (`claude-opus-4-8`), sage (`claude-sonnet-4-6`), ophir/automator/auditmaster (`claude-code`)
  - Codex: codexer (`gpt-5-codex`)
  - OpenCode/OpenRouter: opencode (`openrouter/moonshotai/kimi-k2-thinking`)
  This confirms the brief's "8/10 on Anthropic" single-vendor concentration and is why the fleet broke this morning when Anthropic credits depleted.

---

## 3. DESIGN

### 3.1 Part 1 — Architecture ruling: KEEP separate short-lived workers, but as the default only for TRIAGE-class crons; DO NOT move comms-check inline

Decision, with the reasoning Josh can push back on:

- **Inline in frank2's main loop — REJECTED.** Comms-check every 15m inline would (a) burn frank2's main context window continuously (the exact context-bloat the consolidation is fighting — frank2 already force-restarts at 80% ctx ~7×/day per its crashes.log), and (b) route every triage Bash call through the interactive permission hook (2.3), stalling the main session. The main session must stay lean and interactive.
- **One long-lived comms worker — REJECTED.** A persistent worker accumulates context over hours (comms triage reads untrusted email every 15m → prompt-injection surface grows), has no clean restart story, and re-introduces exactly the "worker never exits" leak class (`incident_frank2_worker_leak`) if its self-terminate ever fails to fire. Ephemeral = bounded blast radius.
- **Short-lived worker per fire — KEEP (this is already the design).** It is the right call: fresh context each run (injection-resistant), `--skip-permissions` so no 30-min stalls, bounded by `MAX_WORKER_LIFETIME_MS`, self-reaps. The ONLY problems were (a) the false-crash classification (2.2) and (b) the historical leak when self-terminate didn't fire — both are worker-lifecycle bugs, NOT architecture flaws. The fix is to harden the lifecycle, not change the topology.

**Net:** the architecture is correct. WS11 spends its build budget on hardening (Parts 2 + 3), not on re-plumbing. This is the anti-churn call — do not rebuild a working topology.

One additive hardening to the topology (small): add a daemon-side **worker idle-reaper** so a hung worker (self-terminate never fired) is reaped even if the SKILL step is skipped — closing the open item flagged in `incident_frank2_worker_leak` ("framework idle-reaper for hung workers"). This is a backstop for `MAX_WORKER_LIFETIME_MS` that reaps on IDLE (no stdout for N minutes) rather than only on absolute lifetime.

### 3.2 Part 2a — Kill false crashes at the source

Make worker-vs-agent detection robust so a normal (or even failed) worker exit can NEVER be classified as an agent `crash`:

1. **Promote `.is-worker` to the PRIMARY signal and check it FIRST.** In `hook-crash-alert.ts main()`, move the worker check to the very top: if `CTX_WORKER` OR `.is-worker` marker exists in the resolved `stateDir`, log to crashes.log with `worker=1` and RETURN before any crash classification / count / notify. Keep the `/-\d{10,}$/` name-suffix as a THIRD fallback only (belt-and-suspenders), documented as such. Today the marker path runs but only AFTER the suffix early-return, and the suffix is the one that actually fires first — invert the priority so the robust signal wins.
2. **Never let a worker inflate `.crash_count_today`.** Already correct (line 334 gates on `!isWorker`) — preserve it, add a test that asserts it.
3. **Regression guard = the falsifiable test (pairs with WS10 R8 harness).** Add a unit test that spawns a synthetic SessionEnd for a `.is-worker` stateDir with NO restart marker and asserts: (a) no Telegram send, (b) no `chief`/`analyst` bus notify, (c) crashes.log line carries `worker=1`, (d) `.crash_count_today` unchanged. Run it against BOTH a `CTX_WORKER=1` env and a bare `.is-worker` marker with a NON-epoch name (proving gap A is closed).

This is deliberately minimal: the message string (line 457) stays; we fix the CLASSIFICATION that reaches it, not the wording.

### 3.3 Part 2b — Autonomous crons must not stall on permission prompts

Root cause: an autonomous cron injected into the main PTY issues a tool call that trips the interactive permission hook, which then blocks 30 min. Design a "cron-originated calls are non-interactive" path WITHOUT making the whole main session skip-permissions:

- **Preferred: tag cron-injected turns as autonomous.** The cron injection string already has a machine-detectable prefix `[CRON FIRED <iso>] <name>:` (`agent-manager.ts:1212`). Have the daemon write a short-TTL marker `state/<agent>/.cron-active` (name + expiry, e.g. now+cron-budget) immediately before `injectAgent()` in `onFire`, and clear it when the cron's task completes / after a max budget. In `hook-permission-telegram.ts main()`, if `.cron-active` is present and unexpired, do NOT block 30 min: emit the decision per a **cron permission policy** (below) and return immediately. This scopes non-interactivity to the window a cron is actually running, not the whole session.
- **Cron permission policy (safe default = deny-fast, not allow):** on a cron-active permission request, `deny` IMMEDIATELY (no 30-min wait) with reason "auto-denied: cron-originated, no human present" AND log a bus event `cron_permission_denied` with tool + cron name so the digest can surface "cron X needs a permission it can't get — make it skip-permissions-safe or move it to a worker." This fixes the STALL (30 min → instant) without silently granting sensitive actions. Crons that legitimately need privileged Bash should be refactored to run in a `--skip-permissions` WORKER (like comms-check already is), which the denial event will flag.
- **Alternative considered (rejected as default):** auto-ALLOW cron-originated calls. Rejected because the main session is where genuinely sensitive actions live; a prompt-injected email processed by an inline cron could trick an auto-allow into a destructive Bash. Deny-fast + surface is the security-first choice consistent with the fleet's "staging-first / security-first" posture.
- **Kill the misleading Telegram.** The `Permission request TIMED OUT (auto-denied)` Telegram (line 99-101) should NOT fire for cron-originated denials (Josh gets a digest line instead, not a raw 30-min-late buzz). Keep it only for genuinely interactive (non-cron) timeouts, or drop it entirely in favor of the bus event.

### 3.4 Part 3 — Orchestrator digest (reslice by AGENT + harness split)

Build a single deterministic script `scripts/build-agent-digest.py` (mirrors the programmatic, no-AI-in-the-publish-loop pattern of `morning-brief.sh`) that emits the digest markdown, then feed it into the existing dashboard publish path. Structure:

```
🌅 Fleet Digest — Sat Jul 4
Tasks done 14 · Approvals needed 2 · Blocked 1
Harness: Claude 71% · Codex 22% · OpenCode 7%     ← WS8 when live; fallback = agent-model mapping

🟣 larry (Opus 4.8)
  • Merged PR #699 context-handoff lifecycle
  • Filed 6-bug pipeline audit as one task
🔵 codexer (Codex)
  • WS1 briefs lost-update fix — diff returned, tests green
🟢 muse (Sonnet-5)
  • 2 OBF specs (muse-fleet-activity-digest 01+02)
… one block per ENABLED agent with overnight output …
```

Data sourcing (all already available to frank2 — no new telemetry needed for v1):

- **Per-agent blocks:** `cortextos bus read-all-heartbeats` (status + last activity per agent) + `cortextos bus list-tasks --status completed` since last digest, grouped by `assignee`/agent, + `log-event` activity entries. This is the SAME data `morning-review` Phase 0 already pulls — resliced by agent instead of by category.
- **Header counts:** tasks-done = completed tasks in the window; approvals = pending items from the `approvals` skill / `check-approvals` cron output; blocked = tasks `in_progress` > 6h with no update (the `midday-blockers` heuristic) + agents with stale heartbeat (>5h, the morning-review flag).
- **Harness split (WS8-dependent):**
  - **v1 fallback (ship now):** deterministic mapping from each enabled agent's `config.json` `model` field → harness bucket (claude-\* → Claude, gpt-\*-codex → Codex, openrouter/\* → OpenCode), weighted by that agent's activity-event count in the window as a proxy for "how much each harness did." Clearly label it "usage by activity (approx)" so it is not mistaken for true cost/token split.
  - **v2 (when WS8 lands):** swap the proxy for real per-call model/token/cost telemetry. Design `build-agent-digest.py` to read a single `usage_split()` function so the swap is one function, not a rewrite. This is the ONLY cross-WS coupling; declare it explicitly.
- **Publish:** write the digest markdown to a temp file and route it through the existing `build_dashboard.py` as a dashboard tab (the standing "briefs → website, send only the URL" rule), then Telegram the dashboard URL. Reuse `morning-brief.sh`'s env-source + URL-capture block verbatim.

Cron changes:

- **Make morning-brief DAILY:** change `morning-brief` cron `3 8 * * 1-5` → `3 8 * * *` (fixes "no Saturday brief"). Same for `evening-wrap` if Josh wants a 7-day evening digest (open question 7.3).
- **Wire the digest:** have `morning-brief.sh` (and `evening-wrap`) call `build-agent-digest.py` to produce the agent-resliced content BEFORE `build_dashboard.py`, so the dashboard's top tab is the digest.
- **Surface `errored>0`:** in `build-agent-digest.py` and `morning-brief.sh`, treat any source that reports `errored>0` (or throws) as a RED header line ("⚠️ 3 sources errored — trending, wiki-synth, …") rather than silently showing `generated=0`. Distinguish "quiet night, nothing to report" from "everything failed."

---

## 4. STAGING / PROD-OPS (Josh-gated, staging-first)

No production DATA is deleted or restructured, so the AuditOS-class staging gate does not apply. But these ARE live-fleet behavior changes and must be validated before they touch the running daemon:

1. **Hook changes (2a, 2b) require a daemon rebuild + reload.** Per `reference_fleet_daemon_restart_guard`, a full `pm2 restart cortextos-daemon` bounces the whole fleet and is hook-blocked — needs a dated `/tmp` approval marker + Josh sign-off. Validate the rebuilt hooks against the unit tests (3.2 regression guard) and a synthetic worker exit BEFORE reloading the live daemon.
2. **Verify the crash-alert fix is actually deployed, not just built** (per `feedback_agents_claim_live_without_verifying_deploy`): after reload, force one comms-check worker to exit and confirm NO new `type=crash` line and NO Telegram — read the TRUNCATED crashes.log after a clean restart, not a stale tail (`feedback_verify_via_truncated_log_not_stale_tail`).
3. **Cron schedule + digest changes** are config/script-only (no daemon rebuild) but must be verified end-to-end: run `build-agent-digest.py` by hand, confirm the dashboard tab renders, and **curl the dashboard URL before it is sent to Josh** (`feedback_verify_links_before_sending` — the 2× 404 briefs-link incident).
4. **Route any Railway/CI noise from the briefs redeploy to Larry, never Josh** (`feedback_railway_alerts_route_to_larry`).

---

## 5. FILES TO TOUCH (tight)

- `src/hooks/hook-crash-alert.ts` — invert worker-detection priority (marker/`CTX_WORKER` first, suffix as fallback); add regression test hooks. (2a)
- `src/hooks/hook-permission-telegram.ts` — read `.cron-active` marker; deny-fast + bus event for cron-originated calls; suppress the timeout Telegram for cron denials. (2b)
- `src/daemon/agent-manager.ts` (`onFire`, ~line 1205) — write/clear the `.cron-active` marker around `injectAgent()`. (2b)
- `src/daemon/worker-process.ts` — add idle-reaper backstop (optional hardening). (Part 1)
- `orgs/clearworksai/agents/frank2/scripts/build-agent-digest.py` — NEW; agent-resliced digest + header + harness-split (with `usage_split()` seam for WS8). (Part 3)
- `orgs/clearworksai/agents/frank2/scripts/morning-brief.sh` — call `build-agent-digest.py`; surface `errored>0`. (Part 3)
- `orgs/clearworksai/agents/frank2/config.json` — `morning-brief` cron → `3 8 * * *` (daily); optionally `evening-wrap`. (Part 3)
- Tests under `tests/` for both hooks (worker-exit-not-a-crash; cron-active-denies-fast). (CLAUDE.md: add unit tests for new code.)

Files deliberately NOT touched: the comms-check-worker SKILL topology (architecture is correct), `build_dashboard.py` (reused as-is), the message string at hook-crash-alert.ts:457.

---

## 6. TEST PLAN

1. **Worker-exit-not-a-crash (unit):** synthetic SessionEnd, `.is-worker` present, no restart marker, NON-epoch name, `CTX_WORKER` unset → assert no Telegram, no chief/analyst notify, crashes.log has `worker=1`, `.crash_count_today` unchanged. Repeat with `CTX_WORKER=1`.
2. **Real-agent crash still pages (unit):** no worker marker, no restart marker, no rate-limit signature → assert `type=crash`, count increments, chief+analyst notified, Telegram fires. (Prove we did not over-suppress.)
3. **Rate-limit still suppresses (unit):** stdout has `usage limit` → `type=rate-limited`, no 🚨. (Prevent regression of the existing fix.)
4. **Cron-active deny-fast (unit):** permission request with `.cron-active` present → decision `deny` returned in <2s (not 30 min), bus event `cron_permission_denied` logged, no timeout Telegram.
5. **Interactive still asks (unit):** permission request with NO `.cron-active` → still sends Telegram + waits (unchanged behavior for real human-in-the-loop asks).
6. **Digest render (integration, staging):** run `build-agent-digest.py` against a fixture of heartbeats/tasks/events → assert one block per enabled agent, header counts correct, harness split sums to 100%, `errored>0` produces a RED line.
7. **Daily brief fires Saturday (ops):** after cron change, confirm `3 8 * * *` produces a brief on a weekend day; curl the URL before it is considered passing.

---

## 7. RISKS + OPEN QUESTIONS FOR JOSH

**Risks:**
- **R1 — deny-fast could break a cron that legitimately needed a privileged Bash.** Mitigation: the `cron_permission_denied` bus event surfaces exactly which cron/tool was denied, so we convert those to skip-permissions workers deliberately rather than discovering breakage silently. Safe default (deny) over unsafe default (allow).
- **R2 — daemon reload to deploy hook fixes bounces the fleet.** Mitigation: Josh-gated dated-marker restart per the restart guard; validate against unit tests first.
- **R3 — harness split v1 is a proxy, not true cost.** Mitigation: labeled "approx (by activity)"; `usage_split()` seam swaps to WS8 telemetry with no digest rewrite. Do not let Josh read the v1 number as a billing figure.
- **R4 — the FPs may already be gone** (Jul 4 10:58 rebuild shipped the suffix guard). If verification (STAGING step 2) shows zero new FP lines, Part 2a shrinks to "harden priority + add the regression test" rather than a live-bug fix. Do not narrate a re-catch of an already-fixed bug (`feedback_fix_once_dont_narrate_recurring_bugs`).

**Open questions:**
- **Q1 (Part 1):** Confirm the ruling — keep ephemeral-worker-per-fire, spend budget on hardening not re-plumbing? (I recommend yes.)
- **Q2 (Part 2b):** Deny-fast (recommended, security-first) vs auto-allow for cron-originated permission calls? Auto-allow is more convenient but opens a prompt-injection path through inline comms crons.
- **Q3 (Part 3):** Should `evening-wrap` also go daily (`* * *`), or keep evenings weekday-only and only fix the MORNING brief for weekends?
- **Q4 (Part 3):** Digest = replace the current dashboard top tab, or add as a NEW "Fleet" tab alongside the 6 existing ones?
- **Q5 (WS8 coupling):** Ship the v1 activity-proxy harness split now, or hold the harness line out of the digest header until WS8 delivers real telemetry? (I recommend ship v1 labeled approx — Josh explicitly wanted the harness split from the creator video, and a labeled proxy beats a missing line.)

---

## 8. EFFORT + PIPELINE

- **Effort: M.** Two focused hook edits + one daemon marker + one new deterministic Python script + cron/schedule tweaks + a tight test suite. No new subsystems; reuses the existing worker topology, dashboard publish path, and morning-review data collection.
- **Pipeline needed: YES (M2C1 through codexer).** The two hook edits are production `src/` TypeScript touching the crash/permission path — Larry writes the spec, codexer implements with worktree isolation + the regression tests as the gate (per WS12 direction). The Python digest script + cron/config edits are lower-risk and can ride the same PR. Part 2a may collapse to test-only if R4 verification shows the FP is already dead — decide that at the top of execution, before writing code.
