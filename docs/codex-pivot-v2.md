# Codex Pivot v2 — Status

**Last updated:** 2026-05-22  
**Spec:** `orgs/revops-global/agents/analyst/output/codex-limit-pivot-plan-2026-05-22.md`  
**Greg directive:** Claude Code is the failover for Codex degradation. No always-on agent on a weekly-capped tier. Full OpenAI-API-direct pivot rejected.

---

## Implementation Status

| # | Task | Status | PR |
|---|---|---|---|
| 1 | spawn-worker auth-model spike | ✅ Complete | — |
| 2 | `src/bus/codex-fallback.ts` (parseCodexLimit + handleCodexFallback) | ✅ Complete | #414 |
| 3 | `--auto-fallback` flag in spawn-codex + computer-use CLI | ✅ Complete | #415 |
| 4 | Dashboard panel + selective enable + 48h monitor | ✅ Complete | This PR |
| 5 | Spillover-2 via Team workspace OAuth (CLAUDE_HOME + `--home` flag) | 🔄 In progress | — |
| 6 | First production failover dry-run | ⏳ After #5 | — |

---

## Architecture

```
Agent → cortextos bus spawn-codex / computer-use
               │
               ├─ exit 0 → done
               └─ exit nonzero + 429 detected
                       │
               src/bus/codex-fallback.ts
                       │
               parseCodexLimit(stderr, exitCode)
                       │
               ├─ short_throttle (Retry-After ≤ 30min): emit codex_limit_hit, no spawn
               ├─ auth_expired (401): emit codex_limit_hit, no spawn
               └─ long_lock (Retry-After > 30min or absent):
                       ├─ emit codex_limit_hit
                       ├─ if --auto-fallback=true:
                       │       ├─ spillover-1: spawn-worker codex-spillover-1-* --model claude-opus-4-7
                       │       │              (Max OAuth via default HOME ~/.claude/)
                       │       └─ spillover-2 (if CLAUDE_TEAM_HOME set):
                       │              spawn-worker codex-spillover-2-* --model claude-opus-4-7
                       │                          --home $CLAUDE_TEAM_HOME
                       │              (Team workspace OAuth via $CLAUDE_TEAM_HOME/.claude/)
                       └─ emit codex_failover_dispatched (one per tier dispatched)
```

## Codex Account State

| Account | Status | Role |
|---|---|---|
| gregharned@gmail.com | Working | Active fleet binding for all Codex nodes |
| greg@revopsglobal.com | Weekly-locked | Sidelined until ~2026-05-26 organic reset |
| support@revopsglobal.com | Weekly-locked | Sidelined until ~2026-05-26 organic reset |

## Selective Enable — 48h Monitor Window

**Started:** 2026-05-22  
**Ends:** ~2026-05-24  
**Enabled agents:** `agentops-orch`, `design-agent`

Both agents have `codex_auto_fallback: true` in their `config.json`. Low-traffic cadence chosen to minimize blast radius during validation.

**Revert path:** Set `codex_auto_fallback: false` in agent `config.json` and remove `--auto-fallback` from any spawn-codex/computer-use call sites in prompts.

**Widen to all Codex-runtime agents:** Requires separate orchestrator approval after 48h window and analyst review of `codex_failover_dispatched` event stream.

## Spillover Budget

- **Soft cap:** $400/mo Claude Opus 4.7 spillover spend (Greg-approved)
- **Estimate:** ~$0.40/dispatch (rough; calibrate from actual runs)
- **Monitor:** Dashboard → Analytics → Codex Account Health panel

## Dashboard Panel

Location: Analytics → Codex Account Health  
Data sources:
- `~/.cortextos/<instance>/state/oauth/accounts.json` (five_hour_utilization, seven_day_utilization)
- SQLite events DB, types: `codex_limit_hit`, `codex_failover_dispatched`

Alert thresholds: page orchestrator when 5h-band ≥ 80% OR weekly cap ≥ 80% used.

## Spillover Worker Design

Workers are ephemeral sessions spawned via `cortextos bus spawn-worker`:
- **Name:** `codex-spillover-1-<timestamp>` (Max OAuth) or `codex-spillover-2-<timestamp>` (Team OAuth)
- **Model:** `claude-opus-4-7`
- **Lifetime:** task completes → `send-message <parent> normal "done: ..."` → `terminate-worker <name>`
- **Auth (spillover-1):** inherits local Max 20x OAuth from `~/.claude/.credentials.json` (`claudeAiOauth` key)
- **Auth (spillover-2):** Team workspace OAuth from `$CLAUDE_TEAM_HOME/.claude/.credentials.json` — set via `--home` flag which overrides `HOME` in the worker PTY env

Prompts MUST end with the terminate-worker instruction — workers do not self-exit.

## Task #5: spillover-2 via Team workspace OAuth

Greg decision (2026-05-22): use Team-user OAuth instead of API key. `greg@revopsglobal.com` on RevOps Global team workspace.

**Implementation (in progress):**
- `CLAUDE_HOME` mechanism: set `HOME` env var in PTY to redirect claude credential lookup
- `spawn-worker --home <path>` flag threads through CLI → IPC → agent-manager → worker-process → agent-pty
- `CLAUDE_TEAM_HOME=~/.claude-team` in `secrets.env` enables spillover-2 tier
- `codex-fallback.ts` reads `CLAUDE_TEAM_HOME` from env and dispatches spillover-2 in parallel with spillover-1 on every long_lock

**Provisioning needed (blocking):**
1. Greg: run `HOME=~/.claude-team claude auth login` on Mac, log into greg@revopsglobal.com Team workspace
2. SCP `~/.claude-team/.credentials.json` from Mac to this VM at `~/.claude-team/.credentials.json`
3. Dev: add `CLAUDE_TEAM_HOME=/home/cortextos/.claude-team` to `secrets.env`
4. Dev: verify spillover-2 worker boots under Team subscription

## Open Items

- **Task #5:** Awaiting Greg's Team workspace OAuth credentials on this VM (see provisioning steps above)
- **Task #6:** First production failover dry-run (analyst + dev) after #5 + 48h window closes (~2026-05-24T23:18Z)
