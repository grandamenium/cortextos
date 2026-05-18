# cortextOS — Wave-1 Architecture & Onboarding

**Audience:** a senior engineer (Node/TypeScript + Python + Claude Code) who has never seen this codebase, dropping in after Wave-1 to either operate the fleet or extend the substrate.

**Companion docs:**
- [SESSION-STATE.md](./SESSION-STATE.md) — full chronology of Wave-1 (22/24 tasks, 16 commits)
- [MULTI-HOST.md](./MULTI-HOST.md) — multi-host conformance rationale
- [RUFLO-EVAL-RUNBOOK.md](./RUFLO-EVAL-RUNBOOK.md) — ruflo eval gate status

---

## 1. What cortextOS is

cortextOS is a small TypeScript daemon (PM2-supervised) that runs N long-lived Claude Code agents per host as PTY-attached subprocesses, gives them a shared HMAC-signed JSON-file bus (per-agent inboxes under `~/.cortextos/<instance>/inbox/<agent>/`), and projects a Next.js dashboard + a `cortextos` CLI over the whole thing. The substrate runs on at least two physical machines — Hari's MacBook (`hari@Haris-MacBook-Pro`, 3 agents: `sam`, `warden-mb`, `pa`) and his Mac mini (`subbu_ai_assistant@mac-mini`, 12 agents: `chief`, `analyst`, `dev`, `forge`, `research`, `security-vp`, `redteam`, `blueteam`, `home-net`, plus relays) — that share `orgs/` via a private gitea remote. The daemon is host-aware: `enabled-agents.json` (checked into git) carries a `host` field per entry, and each daemon only spawns agents whose `host` matches `currentHostId()`, so a `git pull` can't accidentally clone `sam` onto the Mac mini and eat Hari's inbound Telegram polling. Wave-1 (2026-05-17 → 18) closed 22 of 24 tasks across 20 commits to `gitea/main` — substrate hardening, four new operator-facing primitives, and the multi-host conformance tests that lock it all in.

---

## 2. The Wave-1 picture

```
                       gitea/main (orgs/, agents.yaml, src/)
                       ──────────────┬──────────────
            git pull / push          │          git pull / push
            ──────────────►          │          ◄──────────────
                                     │
   ┌────────────────────────┐        │        ┌────────────────────────┐
   │ MacBook (host #1)      │        │        │ Mac mini (host #2)     │
   │ hostId:                │        │        │ hostId (CTX_HOST       │
   │ hari@Haris-MacBook-Pro │        │        │ override):             │
   │                        │        │        │ subbu_ai_assistant@    │
   │                        │        │        │ mac-mini               │
   │  PM2: cortextos-daemon │        │        │  PM2: cortextos-daemon │
   │   ↑ ecosystem.config.js│        │        │   ↑ same file          │
   │     (HOME-portable)    │        │        │                        │
   │   ↑ daemon.env         │        │        │   ↑ daemon.env         │
   │     (per-host env)     │        │        │     (CTX_HOST, tokens) │
   │                        │        │        │                        │
   │  reads agents.yaml ────┼────────┼────────┼──► reads agents.yaml   │
   │  filters by host field │        │        │  filters by host field │
   │                        │        │        │                        │
   │  spawns PTYs:          │        │        │  spawns PTYs:          │
   │   sam, warden-mb, pa   │        │        │   chief, analyst, dev, │
   │                        │        │        │   forge, research, ... │
   │                        │        │        │                        │
   │  per-agent inbox at    │        │        │  per-agent inbox at    │
   │  ~/.cortextos/default/ │        │        │  ~/.cortextos/default/ │
   │    inbox/<agent>/*.json│        │        │    inbox/<agent>/*.json│
   │                        │        │        │                        │
   │  bus: HMAC-verify,     │        │        │  bus: HMAC-verify,     │
   │  typed-contract parse  │        │        │  typed-contract parse  │
   │                        │        │        │                        │
   │  circuit breaker scans │        │        │  (same)                │
   │  stdout for 401/429    │        │        │                        │
   └────────────┬───────────┘        │        └────────────┬───────────┘
                │                                          │
                │  bus-signing-key (HMAC-SHA256, 32B random)
                │  distributed via scp once → lives at
                │  ~/.cortextos/<instance>/config/bus-signing-key
                │  grace window: CTX_BUS_AUTH_GRACE_UNTIL=<ISO>
                │  post-grace: fail-closed on signature mismatch
                │
                └──► operator surface: `cortextos status` (one JSON
                     shape: host + daemon + agents + bus + breaker
                     + HMAC + manifest drift + crashes)
                     plus `swarm`, `tdd-loop`, `scope-plugins`
```

Four hinge points: `ecosystem.config.js` resolves at PM2-startup via `process.env.HOME` so the same file works on both hosts; `daemon.env` is the per-instance override path the daemon loads at startup; `agents.yaml` is the manifest both daemons consult; and `cortextos status` is the canonical observable surface.

---

## 3. The four substrate moves that mattered most

These four landed in the first two Wave-1 commits and unblocked everything downstream. Each fixed a bug class — not just one bug — so future regressions in the same shape are caught at boot.

### 3.1 HOME-portable `ecosystem.config.js`
- **Why:** the previous file baked `/Users/hari/cortextos/dist/daemon.js` in as a literal. Mac mini's home is `/Users/subbu_ai_assistant`, so PM2 silently spawned the daemon against a missing path and looped on restart.
- **What:** `const HOME = process.env.HOME || require('os').homedir();` then every path goes through `path.join(HOME, "cortextos", ...)`. Auto-generated by `cortextos ecosystem`, never edited by hand.
- **Where:** `/Users/hari/cortextos/ecosystem.config.js`; generator at `src/cli/ecosystem.ts` — task #74, commit `b0cf213`.

### 3.2 `daemon.env` loader
- **Why:** before, injecting `CTX_HOST=subbu_ai_assistant@mac-mini` or rotating a Telegram token meant editing the PM2 ecosystem block, which lives in the repo and `git pull`s to every host. Per-host secrets leaked into commits.
- **What:** the daemon, at startup, loads `~/.cortextos/<instance>/config/daemon.env` and merges it into `process.env` before any agent starts. Variables already set in the parent env win (so `pm2 start --update-env` still works). Out-of-git.
- **Where:** `/Users/hari/cortextos/src/daemon/index.ts` (lines 49, 236-244) — task #76, commit `b0cf213`.

### 3.3 Host-based agent scoping
- **Why:** with `orgs/` shared via git, every host saw every agent's directory. Pre-Wave-1, the daemon ran every dir whose `config.json` said `enabled: true`. So `sam` (the MacBook's primary Telegram inbound) spawned on the Mac mini too, polled the same bot, and silently stole half of Hari's inbound messages.
- **What:** `enabled-agents.json` entries now carry an optional `host` field. `discoverAndStart()` computes `currentHostId()` and skips agents whose declared host doesn't match. Backwards-compat: legacy `status: "remote"` still honored when `host` absent.
- **Where:** `currentHostId()` + the skip branch in `discoverAndStart()` in `/Users/hari/cortextos/src/daemon/agent-manager.ts` (lines ~50, ~146) — task #75, commit `b0cf213`.

### 3.4 `agents.yaml` runtime integration
- **Why:** before, `bootstrap` blindly probed every agent for Telegram credentials. Agents like `forge` (builder, no Telegram by design) returned 401, the retry loop kicked in, and the operator got woken up.
- **What:** 18-entry per-agent manifest declaring `telegram_enabled`, `bot_token_env_var`, `role`, `host`, etc. The agent-manager loads it once at startup via `loadAgentsManifest` and uses `telegram_enabled: false` to suppress retries. Also consumed by `cortextos status` (roles), `scope-plugins` (role → plugin maps), and the conformance tests.
- **Where:** `/Users/hari/cortextos/agents.yaml`; loader at `src/daemon/agents-yaml.ts`; consumer at `src/daemon/agent-manager.ts` — task #62, commit `57e54ef` (29 tests).

---

## 4. The four primitives that didn't exist before Wave-1

Each of these elevates a manual operator pattern into a first-class CLI surface with a JSONL trail you can resume from.

### 4.1 Restart circuit breaker
**Before:** on a 401 (auth) or 429 (quota), PM2 would faithfully restart the agent 50 times in a row, burning API quota and waking the operator with crash alerts whose only fix was "wait."
**Now:** every agent exit is classified by a pure-function pattern matcher against the last 200 lines of stdout. `rate_limit` → exponential cool-down (60s → 1800s cap, reset after 30 min clean). `auth` → after 3 occurrences inside 15 min, HALT the agent (no auto-restart) and fire one operator alert. `unknown` → existing PM2 `max_restarts` preserved.
**Invocation:** breaker state surfaces in `cortextos status` under "Circuit breaker"; `cortextos restart <agent>` force-resets.
**Where:** `/Users/hari/cortextos/src/daemon/restart-circuit-breaker.ts`, integrated in `agent-process.ts` — task #60, commit `edbcdbf` (16 tests).

### 4.2 Per-agent plugin scoping
**Before:** every agent inherited the user's full Claude Code plugin set — a code-writer agent had `frontend-design`, a security agent had everything. Noisy permission prompts and a wider auth surface than necessary.
**Now:** `cortextos scope-plugins --dry-run` reads `agents.yaml`, derives a role → plugin allowlist (security roles get only `fewer-permission-prompts` + `simplify` + `hookify`; `personal_assistant` gets Telegram + Gmail; etc.), and writes per-agent `.claude/settings.json` files. `--apply` commits.
**Where:** `/Users/hari/cortextos/src/cli/scope-plugins.ts` — task #57, commit `71a5fb7` (21 tests). HOME-portable fallback at `359e20e`.

### 4.3 Parallel swarm
**Before:** for the h1r9do repo audit (242 repos × 2 models), Hari had a bash dispatcher (`xargs -P 10`) plus two Python reconcile scripts. Reusable as code, not as a substrate primitive.
**Now:** `runSwarm()` takes `{items, promptTemplate, model (string or array), maxConcurrent, reconcileMode}`, fans dispatches across a bounded promise-pool, writes one `<itemId>.<model>.jsonl` per dispatch under `~/.cortextos/<instance>/state/swarm/<runId>/`, plus a `summary.json` with the per-item agreement matrix. Reconcile modes: `first`, `all`, `majority`. Dual-model vetting (playbook §10) is now `model: ["claude-sonnet", "codex"]` + `reconcileMode: "majority"`.
**Invocation:**
```bash
cortextos swarm run --input items.jsonl --prompt-file p.md \
  --model claude-sonnet --max-concurrent 10 --reconcile first
cortextos swarm status <runId>
cortextos swarm collect <runId>    # consolidated JSONL on stdout
cortextos swarm reconcile <runId>  # per-item agreement/divergence
```
**Where:** runner at `/Users/hari/cortextos/src/daemon/swarm-runner.ts` (`runSwarm` at line 485); CLI at `src/cli/swarm.ts` — task #65, commit `3717bcf` (59 tests).

### 4.4 Autonomous TDD loop
**Before:** running TDD on a small feature meant N rounds of paste-spec → write tests → run vitest → paste failures → iterate. Operator-in-the-loop every iteration.
**Now:** `cortextos tdd-loop --spec <spec.md>` reads the markdown spec, asks Claude to write failing vitest tests for the acceptance criteria, then iterates (run → analyze → patch → retest) until green or a max-iterations cap. Every iteration is a JSONL row; resume picks up at the last completed iteration.
**Invocation:** `cortextos tdd-loop --spec spec/my-feature.md --max-iterations 8`. Requires `claude` on PATH (or `claude-sdk-venv`).
**Where:** `/Users/hari/cortextos/src/daemon/tdd-loop-runner.ts`; CLI at `src/cli/tdd-loop.ts` — task #64, commit `48cc873` (36 tests).

### 4.5 `cortextos status` + multi-host conformance
**Before:** an operator who suspected trouble had to run `pm2 jlist`, `cortextos list-agents`, walk inbox dirs, check breaker files, diff `agents.yaml` against disk, eyeball crash logs, and `sha256sum` the bus-signing-key on both hosts. Eight tools, no single output.
**Now:** `cortextos status` returns one `StatusReport` shape (`src/cli/status.ts:49-62`) covering host + daemon + agents-with-roles + bus inbox/error depth + breaker cooldowns + HMAC key fingerprint + manifest drift + last 3 crashes + cross-section alerts. `--watch [seconds]` for live; `--json --watch` emits newline-delimited JSON for `jq -c`.
**Invocation:**
```bash
cortextos status                            # human
cortextos status --json | jq .alerts        # machine
cortextos status --watch 5                  # live, clears screen
cortextos status --json --watch | tee log   # newline-delimited stream
```
**Where:** `/Users/hari/cortextos/src/cli/status.ts`; conformance test at `tests/unit/multi-host-conformance.test.ts` — commit `9bafdd8`.

---

## 5. The two real bugs caught only when we deployed to host #2

Both bugs lived in green-on-MacBook code:

1. **`runtime === 'codex'` check left behind after rename.** `src/daemon/agent-process.ts` kept the old runtime string while every test and the rest of the codebase had been renamed to `'codex-app-server'`. On MacBook this was dead code; on Mac mini, every new codex agent silently routed to the wrong PTY class and crashed at stop with exit 129. Fixed in `c8a8ace`.

2. **Hardcoded `/Users/hari/cortextos` fallback in `scope-plugins`.** When `CTX_FRAMEWORK_ROOT` wasn't set, `src/cli/scope-plugins.ts` fell back to a literal string. The shell-invoked CLI on Mac mini doesn't inherit PM2's env, so the fallback fired and the command bailed with `Could not load agents.yaml from /Users/hari/cortextos` — a path that only exists on MacBook. Fixed in `359e20e`.

**Conclusion:** single-host green is not green. `tests/unit/multi-host-conformance.test.ts` now catches both classes mechanically: (a) no hardcoded `/Users/<user>/` paths in `src/`, (b) no `runtime === 'codex'` checks (only `'codex-app-server'`), (c) every `homedir()`-based framework-root derivation in `src/cli/` must also honor `CTX_FRAMEWORK_ROOT`. Run before any substrate PR: `npx vitest run tests/unit/multi-host-conformance.test.ts`.

---

## 6. The Tier-3 install stack

The voice-PA spine (whisper.cpp / moonshine / supertonic / chatterbox / pipecat / agno / openai-agents), the cashflow stack (open-saas + stripe-toolkit), the memory layer (qdrant on :6333 + mem0 + letta + mcp-memory-service), and the browser layer (browser-use + firecrawl + stagehand) are all installed and import-verified across `~/installs/`. Live docker containers: `qdrant` (:6333), `activepieces` (:9580), `open-saas-postgres` (:5432).

The end-to-end voice-PA demo at `/Users/hari/voice-pa-demo/` proves the local stack works: JFK 11s sample → moonshine STT (885ms) → openai-agents stub (15ms) → supertonic TTS (1748ms) = 13.2s wall clock. A `/voice-pa <wav>` user-level skill at `~/.claude/skills/voice-pa/SKILL.md` makes it invokable from any Claude session.

**Per-package status, sizes, smoke-test outputs, activate-helpers:** `/Users/hari/research/h1r9do/install/INSTALL-STATUS-2026-05-17.md`. Don't re-list — that's the canonical inventory.

---

## 7. What's NOT done + why

- **#69 ruflo alpha-eval gate.** `claude-flow@alpha` v3.7.0-alpha.67 installed; workspace at `/Users/hari/installs/ruflo-eval-workspace/`. Two smoke blockers: (a) federation plugin doesn't ship in alpha-67 (`@claude-flow/plugin-gastown-bridge` registered but CID empty + placeholder checksum); (b) rebuilding from the alpha-33 monorepo fails on `better-sqlite3` native bindings against Node v26. Capability 1 (cross-machine federation) is **blocked until upstream publishes a real CID** or fixes Node 26 builds. Capabilities 2-4 (HNSW, GOAP, Queen-OMC collision) can still run standalone. See [RUFLO-EVAL-RUNBOOK.md](./RUFLO-EVAL-RUNBOOK.md) → canonical at `/Users/hari/installs/ruflo-eval-workspace/EVAL-RUNBOOK.md`.

- **#70 Voice-PAaaS productize v1.** Local pipeline works end-to-end (`~/voice-pa-demo/`). Fakechat-driven interactive demo wired (`~/voice-pa-demo/fakechat/`). Open-SaaS scaffold ready (`~/installs/open-saas-app/` — Wasp 0.23.0, Postgres up, runbook at `~/installs/open-saas-app/RUNBOOK.md`). Remaining: operator fills 24 `TODO_*` placeholders in `.env.server` (min set: Stripe TEST + 3 plan IDs + SendGrid + OpenAI), runs `wasp start`, wires a Twilio test number for real PSTN, signs first 3 customers.

- **Manual rotations + Mac mini plugin install** (operator-only): Anthropic OAuth (`claude login`), Telegram bot 8640425235 (BotFather), git-credential osxkeychain rotation, and `claude plugin add ...` on Mac mini per `agents.yaml` role map (~10 min) then `cortextos scope-plugins --apply`.

---

## 8. What you'd safely change next

1. **Extend swarm with `--retry-on rate_limit`** — wrap the `runSwarm` dispatcher with the breaker classifier so per-item 429s back off instead of marking the item failed. Touch: `src/daemon/swarm-runner.ts` (`dispatchOne` path) + reuse `classifyExitCause` from `src/daemon/restart-circuit-breaker.ts`.

2. **Wire `cortextos status` into the Next.js dashboard** — `await collectStatus()` server-side and render the `StatusReport` shape with auto-refresh + per-host filter. Touch: `dashboard/app/status/page.tsx` + import from `src/cli/status.ts`.

3. **Build `cortextos doctor --fix`** — `src/cli/doctor.ts` currently only diagnoses; add a `--fix` that applies safe remediations (missing bus-signing-key → regenerate + scp; missing daemon.env → write template; ecosystem.config.js out of date → regenerate). Touch: `src/cli/doctor.ts`.

4. **Persist circuit breaker state across daemon restarts** — currently in-memory, so a daemon restart resets the 15-min auth window. Write `~/.cortextos/<instance>/state/<agent>/restart-breaker.json` on each `recordExit` and load on construct. Touch: `src/daemon/restart-circuit-breaker.ts`.

5. **Promote manifest drift from warning to CI gate** — `cortextos status` already reports drift; add a fourth check in `tests/unit/multi-host-conformance.test.ts` that fails when an agent dir on disk has no `agents.yaml` entry.

---

## 9. Glossary

- **HMAC bus signing** — every JSON message dropped into an agent inbox carries `sig = HMAC-SHA256(bus-signing-key, msgId|from|to|text)`. The reader (`src/bus/message.ts`) verifies before parsing. Post-grace-window, signature mismatch drops the message.
- **Host id** — `${user}@${shortHostname}`. Computed by `currentHostId()` in `src/daemon/agent-manager.ts`. `CTX_HOST` env override exists for hosts where the system hostname is wrong (Mac mini's real hostname is `Subbus-Mac-mini` but we set `CTX_HOST=subbu_ai_assistant@mac-mini` for stability).
- **Agent manifest** — `/Users/hari/cortextos/agents.yaml`. 18 entries declaring per-agent `host`, `role`, `telegram_enabled`, `bot_token_env_var`, `org`. Source of truth so retry storms don't fire against agents that were never wired.
- **`daemon.env`** — per-instance, per-host file at `~/.cortextos/<instance>/config/daemon.env`. Loaded by the daemon at startup (`src/daemon/index.ts:49`) into `process.env`. Out-of-git.
- **Circuit breaker** — `src/daemon/restart-circuit-breaker.ts`. Classifies agent exits (`rate_limit` / `auth` / `unknown`) by pattern-matching the last 200 lines of stdout, then applies cool-down or HALT instead of letting PM2 hot-restart through the failure.
- **Swarm dispatch** — `runSwarm()` in `src/daemon/swarm-runner.ts`. Fans (item × model) dispatches across a bounded promise-pool and persists per-dispatch JSONL + summary under `~/.cortextos/<instance>/state/swarm/<runId>/`.
- **Multi-host conformance** — three static-analysis checks in `tests/unit/multi-host-conformance.test.ts` that fail loudly when the Wave-1 bug patterns reappear: hardcoded `/Users/<user>/` literals, incomplete `runtime === 'codex'` renames, and `homedir()`-derived framework roots that ignore `CTX_FRAMEWORK_ROOT`.

---

*Change log + commit chronology: [SESSION-STATE.md](./SESSION-STATE.md). One-shot operator health: `cortextos status`.*
