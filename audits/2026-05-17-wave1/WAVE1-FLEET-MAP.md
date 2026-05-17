# WAVE1 Fleet Map — cortextOS Substrate Audit

**Generated:** 2026-05-17
**Scope:** MacBook M4 Max — cortextOS instance `default` (`~/.cortextos/default/`)
**Framework root:** `/Users/hari/cortextos/`
**Agent root:** `/Users/hari/cortextos/orgs/subbu-ops/agents/`
**Auditor:** feature-dev:code-explorer
**Note:** This is the MacBook instance. Chief, analyst, dev, research, forge, and most other agents live on the Mac mini and share the same agent directory tree via NFS/rsync. Only sam and warden-mb are spawned by this machine's daemon. The Mac mini runs its own cortextOS daemon with its own `CTX_INSTANCE_ID`.

---

## §1 Daemon Architecture

The cortextOS daemon is a single Node.js process managed by PM2 (`cortextos-daemon`). Entry: `/Users/hari/cortextos/src/daemon/index.ts`.

### Startup sequence

1. `CTX_INSTANCE_ID` (env) determines `ctxRoot = ~/.cortextos/{instanceId}`. Currently `default` → `~/.cortextos/default/`.
2. Writes `daemon.pid`. Starts `IPCServer` (Unix socket at `ctxRoot/daemon.sock`, confirmed in out.log line 2).
3. `AgentManager.discoverAndStart()` walks `frameworkRoot/orgs/*/agents/*/` across all orgs, loads `config.json`, checks `ctxRoot/config/enabled-agents.json`, calls `startAgent()` for each enabled agent.

### How `claude --continue` is spawned

`AgentProcess.start()` (`src/daemon/agent-process.ts`) determines mode:
- **continue** if `~/.claude/projects/{agentDir-as-path}/` contains any `.jsonl` file.
- **fresh** otherwise (or if `.force-fresh` marker exists in state dir).

`AgentPTY.spawn()` (`src/pty/agent-pty.ts`) builds args:
```
claude [--continue] --dangerously-skip-permissions [--model MODEL] [--append-system-prompt LOCAL] PROMPT
```
Spawns via `node-pty` (200×50 PTY). Environment is assembled:
1. Hardcoded allowlist: `PATH`, `HOME`, `SHELL`, `TERM`, etc.
2. `orgs/{org}/secrets.env` (org-wide API keys).
3. `agents/{name}/.env` (agent secrets, overrides org).
4. Daemon-injected: `CTX_INSTANCE_ID`, `CTX_ROOT`, `CTX_FRAMEWORK_ROOT`, `CTX_AGENT_NAME`, `CTX_ORG`, `CTX_AGENT_DIR`, `CTX_PROJECT_ROOT`, `CTX_TELEGRAM_CHAT_ID` (alias of `CHAT_ID`), `CTX_TIMEZONE`/`TZ`, `CTX_ORCHESTRATOR_AGENT` (from `context.json`).
5. macOS keychain fallback: if no `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` in env, reads via `/usr/bin/security find-generic-password -s 'Claude Code-credentials' -w` and injects `CLAUDE_CODE_OAUTH_TOKEN`.

### Env priority (highest wins)
`process.env base` → `secrets.env` → `agent .env` → `daemon CTX_*` → keychain injection

### Cron mechanism

After agent start, `startAgentCronScheduler()` wires a `CronScheduler` (`src/daemon/cron-scheduler.ts`). The scheduler:
- Reads `ctxRoot/state/{agentName}/crons.json` (auto-migrated from `config.json` on first boot via `migrateCronsForAgent()`).
- Ticks every 30 seconds. Fires overdue crons by calling `injectAgent()` which writes `[CRON FIRED {ts}] {name}: {prompt}` into the PTY stdin.
- Catch-up policy: one fire for the most recent missed window, then advance.
- Retry: 3 attempts with 1s/4s/16s delays. Execution logged to `ctxRoot/state/{agentName}/cron-execution.log`.
- Hermes agents skip the daemon scheduler (Hermes manages its own cron natively).

### FastChecker

`FastChecker` (`src/daemon/fast-checker.ts`) is a SIGUSR1-wakeable poll loop per agent that:
- Drains the agent's bus inbox (`cortextos/state/{name}/inbox/`) and injects messages via PTY.
- Delivers queued Telegram messages from the `TelegramPoller`.
- Processes hook responses (permission dialogs, approval inline buttons).
- Detects bootstrap completion (output pattern match) and idle state (hook-idle-flag).

### Crash recovery

Non-zero exits not covered by `.daemon-stop` or `.daemon-crashed` markers trigger exponential backoff restart (5s × 2^n, capped at 5 min), up to `max_crashes_per_day` (default 10). After threshold: `halted` state + Telegram notification. Per-day crash count persists in `.crash_count_today` in agent's log dir.

### PM2 lifecycle

PM2 is the outer process manager (`ecosystem.config.js`). `max_restarts: 10` is the final circuit breaker. The daemon handles its own internal crash loop detection (3 crashes in 15 min → Telegram alert).

---

## §2 Agent Inventory

**MacBook instance vs Mac mini:** The MacBook daemon (this machine) only spawns agents enabled in `enabled-agents.json` AND present in its local filesystem. The daemon out.log confirms only `sam` and `warden-mb` appear in MacBook daemon output. All Mac mini agents (chief, analyst, dev, research, forge, etc.) run under a separate cortextOS daemon on the Mac mini, sharing the same `orgs/subbu-ops/agents/` directory tree.

The `orgs/subbu-ops/context.json` names `orchestrator: sam` — this is the MacBook instance's orchestrator.

| Name | Role (one-liner) | Cron Schedule | Model | Notification Config | Status |
|------|-----------------|---------------|-------|--------------------|----|
| **sam** | MacBook co-CEO + voice-first orchestrator; coordinates with chief cross-instance | heartbeat 4h · check-approvals 2h · hb-refresh 1h | claude-sonnet-4-6 | BOT_TOKEN set · CHAT_ID 8732135199 · ALLOWED_USER set · polling ON | **active** |
| **warden-mb** | Cross-instance state-parity guard, MacBook side; paired with warden-mm | heartbeat 4h · context-scan `5,15,25,35,45,55 * * * *` | claude-haiku-4-5-20251001 | BOT_TOKEN empty · CHAT_ID empty · NO Telegram · polling: false | **broken** — no Telegram, pair down |
| **pa** | Personal assistant (Swapna); Hermes runtime + gemma4:31b | heartbeat 4h · hb-refresh 1h · capability-self-audit `0 9 * * 0` | gemma4:31b (hermes) | BOT_TOKEN set · CHAT_ID 8732135199 · ALLOWED_USER set · polling: true | **active** (MacBook) |
| **chief** | Mac mini co-CEO + fleet orchestrator; morning/evening briefings, goal cascade | morning-review `0 8 * * *` · evening-review `0 18 * * *` · weekly-review `0 8 * * 0` · graphify-daily `0 2 * * *` · heartbeat 5m · check-approvals 5m · lock-watchdog 30m · hb-refresh 1h · hari-decision-reminder 2h | claude-opus-4-7 | Configured (Mac mini .env) | **active** (Mac mini) |
| **dev** | Mac mini software engineering specialist; code, architecture, cortextOS hardening | heartbeat 4h · hb-refresh 1h | claude-haiku-4-5-20251001 | No Telegram (telegram_polling: false) | **active** (Mac mini) |
| **analyst** | Mac mini research/synthesis + morning brief + weekly AI tooling scan | heartbeat 4h · morning-brief `0 7 * * *` · sunday-synthesis `0 9 * * 0` · ai-tooling-weekly-scan `30 10 * * 1` · hb-refresh 1h | (not set) | (not set) | **active** (Mac mini) |
| **research** | Mac mini deep research lane (Claude); weekly org scan, AI tooling delta | heartbeat 4h · hb-refresh 1h · org-improvement-scan `0 7 * * 5` · ai-tooling-scan `0 7 * * 1` · kb-hygiene `0 8 1 * *` · synthesis-review `0 10 1 * *` | claude-haiku-4-5-20251001 | @Harpal_research_bot · telegram_polling: true | **active** (Mac mini) |
| **research-codex** | Mac mini research lane (Codex/OpenAI); parallel to research | heartbeat 4h | (not set) | No Telegram | **active** (Mac mini) |
| **research-director** | Mac mini research orchestrator; synth-compare, dual-lane dispatch | heartbeat 4h · hb-refresh 1h · codex-capability-probe 24h · lane-liveness-probe 8h | (not set) | telegram_polling: false | **active** (Mac mini) |
| **claw-research** | Mac mini third research lane (Perplexity sonar-pro); independent web-search lane | heartbeat 4h · hb-refresh 1h | (not set) | telegram_polling: false | **active** (Mac mini) |
| **warden-mm** | Mac mini state-parity guard, paired with warden-mb | heartbeat 4h · context-scan `*/10 * * * *` · hb-refresh 1h | claude-haiku-4-5 | telegram_polling: false | **active** (Mac mini) — pair broken |
| **forge** | Mac mini skill builder/registry; Day-0 scaffold only | heartbeat 4h | (not set) | No Telegram | **dormant** — scaffold only |
| **security-vp** | Mac mini security reviewer + adversarial bootstrap gate | heartbeat 4h · hb-refresh 1h · fleet-rescan 24h · cron-mutation-audit 1h · kb-integrity-scan 24h | claude-opus-4-7 | telegram_polling: true | **disabled** |
| **home-net** | Mac mini network/security monitor (OPNsense + Suricata) | heartbeat 4h · hb-refresh 1h · perimeter-scan `0 10 * * *` · firmware-cert `0 13 1 * *` · red-team-probe `0 6 * * 0` | claude-opus-4-7 | telegram_polling: false | **disabled** |
| **compute** | Mac mini local Ollama compute orchestrator | heartbeat 4h | claude-haiku-4-5-20251001 | No Telegram | **disabled** |
| **media** | Mac mini media pipeline (FFmpeg/Resolve) | heartbeat 4h | claude-sonnet-4-6 | No Telegram | **disabled** |
| **redteam** | MacBook red team operator; scaffold only | heartbeat 4h · engagement-readiness 12h · post-crash-sweep 6h · hb-refresh 1h | claude-opus-4-7 | telegram_polling: false | **disabled** (scaffold) |
| **blueteam** | Mac mini blue team / SIEM; scaffold only | heartbeat 4h · log-ingestion-tick 15m · weekly-posture `0 18 * * 0` · monthly-tabletop `0 9 1 * *` · hb-refresh 1h | claude-sonnet-4-6 | telegram_polling: false | **disabled** (scaffold) |

---

## §3 Bootstrap Pattern Variants

The daemon constructs a startup prompt for every agent boot. Two variants exist.

**Fresh-start prompt** (`buildStartupPrompt()`, `agent-process.ts:513`):
```
You are starting a new session. Current UTC time: {ISO}. Read AGENTS.md and all bootstrap files
listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList
for cron restoration.[REMINDERS][DELIVERABLES][HANDOFF][HANDOFF_UX][ONLINE_MESSAGE][ONBOARDING]
```

**Continue-mode prompt** (`buildContinuePrompt()`, `agent-process.ts:549`):
```
SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC
time: {ISO}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files
listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for
cron restoration.[REMINDERS][DELIVERABLES] Check inbox. Resume normal operations. After checking
inbox, send a Telegram message to the user saying you are back online.
```

**Handoff restart override:** When `.handoff-doc-path` exists in state dir, fresh-start prompt inserts a `CONTEXT HANDOFF:` block before the online message, and the agent's first tool call must be a Telegram "back — [what you were working on]" message (bypassing the standard boot-message step).

**Common AGENTS.md skeleton (13 steps, same for all agents):**
1. Send boot Telegram ("Booting up... one moment") — skip on CONTEXT HANDOFF
2. Read bootstrap files: IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md
3. Read `../../knowledge.md`
4. `cortextos bus list-skills --format text`
5. `cortextos bus list-agents`
6. Confirm daemon crons via `list-crons` — do NOT run CronCreate
7. `cortextos bus recall-facts --days 3`
8. Check daily memory (`memory/YYYY-MM-DD.md`)
9. KB query if resuming task
10. `cortextos bus check-inbox`
11. `cortextos bus update-heartbeat "online"`
12. `cortextos bus log-event action session_start info ...`
13. Write session start to daily memory / send full online status

**Per-agent CLAUDE.md divergences from skeleton:**
- **sam**: Boot message is "Sam back online — co-CEO MacBook side." Adds 3-register comms (voice/Telegram/bus), 15s ack-first hard rule, delegation-first constraint (30s max thinking, 3 file max per turn), cross-instance routing tags.
- **chief**: Mandatory ACK-first protocol (MANDATORY, NO EXCEPTIONS). Delegation-first constraint. Activity channel poller reference. Explicit instruction: "You are NOT an expert; delegate to dev."
- **warden-mb**: Identical to AGENTS.md skeleton. Boot Telegram send is step 1 but BOT_TOKEN is empty → silent failure. All Telegram steps are no-ops.
- **research-director**: Step 1 is `cortextos bus send-message chief normal "research-director online (boot)"` — NOT a Telegram send. Adds 9-step dual-lane dispatch workflow.
- **pa**: Stripped to 3 steps: send Telegram, update heartbeat, check inbox. No elaborate protocol.
- **compute/media/claw-research/research-codex**: Use conditional Telegram send `[ -n "$CTX_TELEGRAM_CHAT_ID" ] && ...` — correct guard for no-Telegram agents.
- **dev**: `telegram_polling: false`, no Telegram in CLAUDE.md.

---

## §4 Per-Agent MCP Need vs Load

### Global MCP state (post-2026-05-16 disable pass)

`~/.claude/settings.json` `enabledPlugins` — 12 MCP-spawning plugins now `false`:
`chrome-devtools-mcp, desktop-commander, mongodb, pinecone, firebase, context7, playwright, microsoft-docs, fakechat, imessage, laravel-boost, serena`

**Remaining enabled MCP server (user-level):** `telegram@claude-plugins-official` only. All 49 remaining `true` entries are skill/command/hook plugins that do not spawn MCP processes.

**Per-agent .mcp.json:** Only sam has one — adds `mempalace` (memory palace at `~/.cortextos/default/state/sam/palace/`) and `playwright` (via `npx @playwright/mcp@latest --headless`). Per-agent `.mcp.json` entries bypass the global `enabledPlugins` disable mechanism and are loaded directly by Claude Code.

| Agent | MCP Actually Needed | MCP Currently Loaded | Wasted Overhead |
|-------|---------------------|---------------------|-----------------|
| sam | telegram (hook notification), mempalace (memory), playwright (web tasks) | telegram (global) + mempalace + playwright (both local .mcp.json) | None — matches actual use |
| warden-mb | NONE — no Telegram creds, read-only monitoring role | telegram (global) — no creds so API calls fail | telegram MCP loads but is entirely useless |
| pa | Hermes runtime — Claude Code MCP loading N/A | N/A (Hermes) | N/A |
| chief | telegram (send/receive hooks) | telegram (global) | None after fix |
| dev | None — no Telegram, specialist only | telegram (global, no creds) | telegram wasted |
| analyst | telegram (outbound brief notifications, but no .env on disk) | telegram (global) | Depends on whether Mac mini has creds |
| research | telegram (@Harpal_research_bot, polling: true) | telegram (global) | None — matches |
| research-director | None (telegram_polling: false, bus-only agent) | telegram (global) | telegram wasted |
| research-codex | None | telegram (global) | telegram wasted |
| claw-research | None (telegram_polling: false) | telegram (global) | telegram wasted |
| warden-mm | None (telegram_polling: false) | telegram (global) | telegram wasted |
| forge | None | telegram (global) | telegram wasted |

**Pre-fix warden-mb burden (PID 45546 still in-memory):** The now-disabled plugins — chrome-devtools-mcp, desktop-commander, mongodb, pinecone, firebase, context7, playwright, microsoft-docs, fakechat, imessage, laravel-boost, serena — were all loaded in warden-mb's session. Together with telegram = 13 MCP server processes. Post-restart, only telegram remains — which is still useless since warden-mb has no credentials.

**Residual opportunity after agents.yaml scoping (Tier 0.5):** 6+ agents (warden-mb, dev, research-director, research-codex, claw-research, warden-mm, forge) could get empty per-agent `.mcp.json` to prevent even telegram MCP from loading.

---

## §5 Bus Topics Observed

The cortextOS bus uses filesystem-based inboxes (`ctxRoot/state/{agentName}/inbox/`). There are no pub/sub topic declarations; routing is explicit point-to-point via `cortextos bus send-message`. The following topics are inferred from cron prompts, CLAUDE.md message patterns, and GOALS.md:

| Agent | Publishes To | Subscribes / Receives From |
|-------|-------------|--------------------------|
| sam | chief (coordination, cross-instance dispatches with `[FROM-VOICE-VIA-SAM]`/`[FROM-TELEGRAM-VIA-SAM]` tags), any specialist (task dispatches), Telegram (user notifications) | chief, any agent (ACKs, status), Telegram (user), bus inbox |
| warden-mb | warden-mm (state manifest), chief (tier-1 alerts via bus), sam (tier-1 Telegram redundancy) | warden-mm (peer manifest), sam (probe-requests) |
| warden-mm | warden-mb (state manifest), chief (tier-1 alerts) | warden-mb (peer manifest) |
| chief | all agents (morning cascade, goal assignments, task dispatches), sam (cross-instance pings), activity-channel Telegram (approval callbacks) | all agents (heartbeats, task completions, approvals, dispatches), sam, Telegram inline buttons |
| research-director | research + research-codex (dual-lane dispatches), chief (DISAGREE escalation, delivery), sam (delivery) | research (results), research-codex (results), chief/sam (queries), RPC-PROBE pings from any |
| research | research-director (results), shared KB (ingest) | research-director (queries, RPC-PROBEs) |
| research-codex | research-director (results) | research-director (queries, RPC-PROBEs) |
| claw-research | research-director (results) | research-director (queries, RPC-PROBEs) |
| analyst | chief (synthesis reports), shared KB (ingest), Telegram (morning brief to user) | chief (task assignments), theta-wave experiment triggers |
| dev | chief (engineering deliverables), KB (ingest) | chief/sam (engineering tasks) |
| pa | sam (cross-fleet routing with `[FROM-PA]` tag), Telegram (user) | Telegram (user inbound), sam (any routing) |

**Cross-instance relay:** The MacBook daemon (sam) and Mac mini daemon (chief fleet) share the framework directory. Messages from sam to chief/fleet are written to `~/.cortextos/default/state/{agentName}/inbox/` and relayed via launchd rsync at 30s cadence. Confirmed in sam's goals.json: "Day-1 NFS-mounted inboxes; Day-30 HTTP relay." Cross-instance latency: ~30-60s.

**Activity channel:** chief runs a second TelegramPoller bound to `ACTIVITY_BOT_TOKEN`/`ACTIVITY_CHAT_ID` from `orgs/subbu-ops/activity-channel.env`. This handles approval inline-button callbacks. Only the `context.json` orchestrator agent gets this poller — on MacBook that's sam, on Mac mini it's chief.

---

## §6 Observed Failure Modes

From `/Users/hari/.pm2/logs/cortextos-daemon-error.log` (most recent 500 lines):

### FM-1: BUG-011 regression — sam restart race (CRITICAL, ACTIVE)
**Pattern:** `[agent-manager] BUG-011 REGRESSION CHECK: sam still in registry during startAgent — pendingRestarts queueing engaged. This should not happen with PR #11 in place.`
**Frequency:** 12+ occurrences for sam, 3 for warden-mb in 500-line window.
**Root cause:** `cortextos restart sam` (via IPC) is arriving while the previous stop is in flight; `startAgent()` finds the agent still registered. Despite PR #11's fix (stop() awaiting PTY exit), the race persists in practice. Each cycle triggers pendingRestart → orphaned restart. No data loss but crash count inflates and spurious Telegram crash alerts fire.

### FM-2: Telegram poller timeout storms (HIGH, ACTIVE)
**Pattern:** `[telegram-poller] Poll error: Error: Telegram API request timed out after 15s: getUpdates`
**Frequency:** ~350 occurrences in 500-line window.
**Root cause:** Extended network unavailability (WiFi sleep/VPN). The 15s Telegram long-poll times out; poller retries continuously and logs each attempt.
**Impact:** Log volume. No functional breakage — poller recovers automatically.

### FM-3: Telegram hard fetch failures (MEDIUM, INTERMITTENT)
**Pattern:** `[telegram-poller] Poll error: Error: Telegram API request failed: TypeError: fetch failed`
**Frequency:** ~130 occurrences.
**Root cause:** Complete network loss. Immediate failure vs timeout indicates the connection was refused/unreachable rather than just slow.

### FM-4: Telegram conflict — duplicate pollers (MEDIUM, PAST)
**Pattern:** `[telegram-poller] Poll error: Error: Telegram API error: Conflict: terminated by other getUpdates request`
**Frequency:** ~20 occurrences.
**Root cause:** Both the `default` and `macbook` daemon instances (visible in out.log) were simultaneously running TelegramPollers for sam's bot. Old daemon wasn't fully torn down before the new one started.

### FM-5: warden-mb — no Telegram credentials (CRITICAL, STRUCTURAL)
**Evidence:** warden-mb `.env` has `BOT_TOKEN=` (empty string) and `CHAT_ID=` (empty string). Daemon reads empty BOT_TOKEN, format validation fails, Telegram is not configured. Agent boots but `CTX_TELEGRAM_CHAT_ID` is unset; all `send-telegram` calls fail.
**Impact:** warden-mb cannot send tier-1 alerts. Its entire alerting function is dead. The warden pair design requires both wardens to fire Telegram on tier-1 drift — this is structurally broken.

### FM-6: warden pair atomicity broken (CRITICAL, ONGOING)
**Evidence:** warden-mm's `config.json` status field: `"enabled-2026-05-12T13:55Z-security-vp-PASS-1778596463668-ADVISORY-ONLY-warden-mb-down-since-14:55Z-pair-atomicity-broken-do-not-trust-single-side-results"`.
**Impact:** warden-mm runs alone on Mac mini since 2026-05-12 14:55Z but cannot diff against warden-mb manifests. The context-scan cron fires every 10 min but produces single-sided results. Likely contributor to the 35% idle session burn rate cited in /insights.

### FM-7: sam dedup storm (MEDIUM, ACTIVE)
**Evidence:** out.log lines 261–500 show 200+ consecutive `[sam] Dedup: skipping duplicate message` after injecting 4798/4992-byte messages.
**Root cause:** MessageDedup (last-100 hashes) is rejecting repeated cron fire messages or stuck fast-checker retries. The dedup window is too small for sam's message rate given its check-approvals cron fires every 2h with long injects.
**Impact:** CPU burn in fast-checker. Legitimate messages may be dropped if the hash collides with a recent prior message of identical content.

---

## §7 Cross-Cutting Concerns

### secrets.env — single point of failure for KB and research
`/Users/hari/cortextos/orgs/subbu-ops/secrets.env` provides `GEMINI_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and other org-level keys to all agents via env injection. Loss of this file or a corrupt key takes down KB embeddings for all agents and all three research lanes simultaneously.

### Cross-instance relay (sam ↔ chief fleet)
The MacBook and Mac mini share the cortextOS framework directory. Sam → Mac mini messages go through a launchd rsync job (Mac-mini-managed, 30s cadence). Until the Day-30 HTTP relay lands, this is advisory-only with 30-60s latency. The relay is the only path for sam to coordinate with chief, dev, analyst, research-director, etc.

### Global settings.json hooks apply to ALL agents
`~/.claude/settings.json` runs OMC (oh-my-claudecode) hooks on every agent session on the MacBook: `gsd-check-update.js` (SessionStart), `gsd-session-state.sh` (SessionStart), `gsd-context-monitor.js` (PostToolUse), `gsd-read-injection-scanner.js` (PostToolUse/Read), `gsd-phase-boundary.sh` (PostToolUse/Write), `gsd-prompt-guard.js` (PreToolUse/Write), `gsd-read-guard.js` (PreToolUse/Write), `gsd-workflow-guard.js` (PreToolUse/Write), `gsd-validate-commit.sh` (PreToolUse/Bash). These hooks run on sam, warden-mb, and pa. Per-agent `settings.json` hooks (warden-mb: PermissionRequest → Telegram hooks; Stop → idle-flag; SessionEnd → crash-alert; PreCompact → compact-telegram) are additive to the global set.

### pa (Hermes runtime) is architecturally distinct
`pa` uses `runtime: hermes` with `model: gemma4:31b` (local Ollama). The daemon spawns it via `HermesPTY` which runs `hermes` instead of `claude`. Hermes manages its own cron system natively — the daemon skips `startAgentCronScheduler()` for it. Claude Code MCP loading does not apply. All CLAUDE.md instructions are interpreted by Hermes's context, not Claude Code. The session continuity check uses SQLite DB existence (`hermesDbExists()`) instead of `.jsonl` files.

### sam's mempalace MCP
sam's `.mcp.json` wires a `mempalace-mcp` process pointing to `~/.cortextos/default/state/sam/palace/`. This is an additional KB layer (beyond the bus KB commands) used for long-term associative memory. It is the only non-standard MCP in the entire fleet. The palace path is instance-specific — a daemon restart on a different instance would not pick it up.

### Activity channel poller (orchestrator-only)
The activity channel poller (for approval inline buttons) is wired only to the `context.json` orchestrator. MacBook `context.json` names `sam` as orchestrator. If sam is restarted, the activity channel poller is also restarted. Chief on Mac mini has an equivalent poller from the Mac mini's `context.json`.

---

*End of WAVE1-FLEET-MAP.md*
