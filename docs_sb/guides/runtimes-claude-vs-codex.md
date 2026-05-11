# Runtimes — claude-code vs codex-app-server

Every cortextos agent runs under a **runtime**: the PTY backend the daemon dispatches to for each turn. As of the 2026-05-11 upstream sync, two are supported in the main path: `claude-code` (default) and `codex-app-server`. A third, `hermes`, exists for experimental Python-REPL agents and is not covered here.

The bus, crons, dashboard, Telegram poller, approval routes, and event logging are **runtime-agnostic** — they behave identically regardless of which backend serves the agent's turn. The runtime only changes:

- which binary is spawned and what protocol the daemon talks to it over
- which model serves the turn by default
- where the agent's skills live on disk and how the agent discovers them
- which auth credentials the agent uses
- where per-turn cost is logged

Everything else — message routing, cron firing, heartbeat shape, dashboard rendering, fleet health — is shared.

## At a glance

| | `claude-code` | `codex-app-server` |
|---|---|---|
| Binary | `claude` (Claude Code CLI) | `codex app-server` (OpenAI Codex CLI) |
| Protocol | PTY stdio | WebSocket-over-Unix-socket JSON-RPC |
| Adapter (src) | `src/pty/agent-pty.ts` (`AgentPTY`) | `src/pty/codex-app-server-pty.ts` (`CodexAppServerPTY`) |
| Default model | `sonnet` (claude-sonnet-4-6) | `gpt-5-codex` |
| Auth | Anthropic OAuth via `claude` / `CLAUDE_CONFIG_DIR` | `codex login` (ChatGPT account or `--with-api-key`) |
| Skills directory (on disk) | `<agent>/.claude/skills/<skill>/SKILL.md` | `<agent>/plugins/cortextos-agent-skills/skills/<skill>/SKILL.md` |
| Skills discovery | Read by Claude Code automatically | Symlinked into `~/.codex/skills/<agent>__<skill>` at scaffold time |
| Bootstrap file | `CLAUDE.md` (re-read each session) | `AGENTS.md` + `ONBOARDING.md` + `TOOLS.md` |
| Per-turn cost log | `~/.claude/projects/*.jsonl` | `<ctxRoot>/logs/<agent>/codex-tokens.jsonl` |
| Multi-account profile (claude_profile / fallback_profile) | Honored — resolves `CLAUDE_CONFIG_DIR` | **Ignored** (codex auth is single-account) |
| Session continuity (`--continue` semantics) | Yes — Claude Code session per `CLAUDE_CONFIG_DIR` | No — every spawn is a cold boot |
| Dashboard runtime badge | none (or "claude-code") | "codex-app-server" |

## Choosing a runtime

| Workload | Recommended runtime | Why |
|---|---|---|
| Telegram-facing orchestrator (boss) | `claude-code` | Owns the poller, needs session continuity across hours of operator chat |
| Cross-repo software engineering | `claude-code` (opus) | Long-horizon multi-file work benefits from Claude session state |
| Ops / infra scripting / one-shot devops tasks | `codex-app-server` | `gpt-5-codex` is purpose-built for code/script tasks; cold-boot turns acceptable |
| Specialist single-purpose tools (reindexers, file rotators) | either | Pick on cost — codex input is cheaper, output is comparable |
| Audit / monitoring (analyst) | `claude-code` (haiku) | Cheap, runs frequently, profile-failover semantics matter |

Boss owns Telegram; do **not** flip it. Engineer does shipping-grade code work; flip only with intent to A/B for at least a week.

## Scaffolding a fresh codex agent

The CLI accepts either of two equivalent forms:

```bash
# Via runtime flag (recommended — keeps default template, swaps to codex variant under the hood):
cortextos add-agent <name> --runtime codex-app-server --org <org>

# Via explicit template:
cortextos add-agent <name> --template agent-codex --org <org>
```

Both paths:

1. Copy `templates/agent-codex/` into `orgs/<org>/agents/<name>/`
2. Write `runtime: "codex-app-server"` + `model: "gpt-5-codex"` into `config.json`
3. Symlink each skill at `plugins/cortextos-agent-skills/skills/<skill>/` into `~/.codex/skills/<name>__<skill>` (`installCodexSkillSymlinks` in `src/cli/add-agent.ts`)
4. Skip the `.claude/skills/` directory (claude-only)

Templates that do **not** yet have a codex variant — `orchestrator`, `analyst`, `m2c1-worker`, `hermes` — reject the `--runtime codex-app-server` combo with a clean error message. The validation list lives in `NON_CODEX_TEMPLATES` at the top of `src/cli/add-agent.ts`.

## Flipping an existing claude agent — two paths

The two-line `jq` edit I gave earlier in chat is **not sufficient on its own** — the daemon will hand the agent to `CodexAppServerPTY`, but the filesystem still has the claude skills layout. Pick one of these:

### Path 1 — Side-by-side (recommended)

Scaffold a fresh codex variant next to the claude original, disable the claude one, retire it only after the codex variant proves itself.

```bash
# 1. Scaffold parallel codex agent
cortextos add-agent <name>-codex --runtime codex-app-server --org <org>

# 2. Disable (not delete) the claude variant
jq '.enabled = false' orgs/<org>/agents/<name>/config.json > /tmp/c.json \
  && mv /tmp/c.json orgs/<org>/agents/<name>/config.json
cortextos stop <name> 2>/dev/null

# 3. Bring the codex variant online
cortextos start <name>-codex
```

Rollback: `.enabled = true` on the claude variant, `.enabled = false` on the codex variant.

### Path 2 — Hard in-place flip (irreversible without manual restore)

Re-scaffold over the existing agent name.

```bash
cortextos stop <name> 2>/dev/null
mv orgs/<org>/agents/<name> orgs/<org>/agents/<name>.bak-claude
cortextos add-agent <name> --runtime codex-app-server --org <org>

# Manually port over from the .bak-claude:
#   - config.json.crons[]
#   - config.json.approval_rules
#   - config.json.day_mode_start / day_mode_end
#   - config.json.communication_style
#   - memory/ directory (if you want history continuity)
#   - MEMORY.md
cortextos start <name>
```

Skips A/B comparison but keeps the agent name stable on the fleet.

## Smoke-testing a codex agent end-to-end

After scaffolding (either path), verify codex is wired correctly before relying on it:

```bash
# 1. Bootstrap reached
timeout 15 tail -f ~/.cortextos/default/logs/<name>/stdout.log &
sleep 8
grep -q "\[codex-app-server\] ready" ~/.cortextos/default/logs/<name>/stdout.log

# 2. Unix socket created
ls -la ~/.cortextos/default/state/<name>/codex.sock

# 3. codex process running
ps aux | grep "codex app-server" | grep -v grep | grep <name>

# 4. Round-trip a turn through the bus
cortextos bus send-message <name> high "Reply with the word PONG."
sleep 10
tail -30 ~/.cortextos/default/logs/<name>/stdout.log | grep -E "turn/completed|PONG"

# 5. Cost log appearing
ls -la ~/.cortextos/default/logs/<name>/codex-tokens.jsonl

# 6. Skill symlinks exist
ls ~/.codex/skills/ | grep "^<name>__" | wc -l   # should be ≥1 per skill
```

If steps 1-5 all pass, codex is end-to-end functional for this agent.

## Codex CLI version requirement

The adapter (`src/pty/codex-app-server-pty.ts`) spawns codex with `--listen unix://./codex.sock`. **This requires `@openai/codex >= 0.128.0`** (the version that re-introduced `unix://` and `unix://PATH` to the `--listen` schema). Earlier versions — including `0.114.0` — only accept `stdio://` or `ws://IP:PORT` and will reject the unix-socket URL with `unsupported --listen URL`, causing `Timed out waiting for app-server socket` on every spawn attempt.

Pinned today: `0.130.0`. Upgrade with `npm install -g @openai/codex@0.130.0`. Verify with `codex app-server --help | grep -A2 listen` — `unix://` must appear in the Supported values list.

After upgrading codex, restart the cortextos daemon (`pm2 restart cortextos-daemon`) so already-running agents pick up the new binary's PATH lookup.

## Failure modes — what to look for

| Symptom | Likely cause | Fix |
|---|---|---|
| `unsupported --listen URL 'unix://./codex.sock'` in stdout | codex CLI < 0.128.0 (no `unix://` listener support) | `npm install -g @openai/codex@0.130.0` + `pm2 restart cortextos-daemon` |
| `spawn ENOENT codex` in daemon log | `codex` not in PATH for the daemon's env | Restart daemon with `codex` in PATH |
| `Timed out waiting for app-server socket` (no `unsupported URL` line) | codex crashed on startup; OpenAI auth missing or expired | `codex login status` — re-login if needed |
| Socket path > 100 bytes | Adapter falls back to `/tmp/cas-<uuid>.sock`. Expected on long org paths | Not an error; informational |
| Boot prompt complaining about missing `AGENTS.md` | PR-A2 trim didn't preserve through merge | Re-grep `src/daemon/agent-process.ts:buildStartupPrompt` for AGENTS.md references |
| Dashboard runtime badge shows "unknown" | `runtime` field absent in `config.json` | Run `scripts/migrate-runtime-field.ts` (backfills `runtime: claude-code` on legacy configs) |
| Skill seemingly not discovered by codex agent | Symlinks not installed | Re-run `installCodexSkillSymlinks` or re-scaffold — symlinks live at `~/.codex/skills/<agent>__<skill>` |
| Profile flag silently ignored after flip | `claude_profile` / `fallback_profile` are claude-only | Move to a single-account codex login; OR keep agent on `claude-code` |

## Where each piece lives in source

| Concern | File |
|---|---|
| Runtime dispatch (claude vs codex vs hermes) | `src/daemon/agent-process.ts` (PTY-class selection by `config.runtime`) |
| AgentPTY (claude) | `src/pty/agent-pty.ts` |
| CodexAppServerPTY | `src/pty/codex-app-server-pty.ts` |
| WS-over-Unix-socket client | `src/utils/ws-unix-client.ts` |
| `add-agent` flow (template routing, symlink install) | `src/cli/add-agent.ts` |
| Codex template tree | `templates/agent-codex/` |
| Skills under codex layout | `templates/agent-codex/plugins/cortextos-agent-skills/skills/` |
| `runtime` field type definition | `src/types/index.ts` (`AgentConfig.runtime`) |
| Codex cost parser | `dashboard/src/lib/cost-parser.ts` (`gpt-5-codex` in `MODEL_PRICING`) |
| Codex-only parity tests | `tests/integration/codex-*.test.ts`, `tests/e2e/lifecycle-codex.test.ts`, `dashboard/src/lib/__tests__/cost-parser-codex.test.ts` |
| Live-config backfill script | `scripts/migrate-runtime-field.ts` |
| Test mock codex binary | `tests/e2e/mock-codex.js` |

Run codex-only parity at any time with `npm run test:codex`.

## See also

- `community/skills/agent-management/SKILL.md` — agent-management skill (RULE 7: always ask runtime before scaffolding)
- `docs_sb/guides/bus-cli-reference.md` — bus commands that work identically across both runtimes
- `templates/agent-codex/AGENTS.md` — what a codex agent reads on session start (analogue of CLAUDE.md)
- Plan file: `/Users/sauravb/.claude/plans/ok-lets-plan-the-linear-tower.md` — 2026-05-11 upstream-sync merge plan covering the codex runtime arrival
