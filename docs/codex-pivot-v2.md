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
| 5 | Team API key activation (spillover-2) | ⏳ Waiting on Greg | — |
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
                       ├─ if --auto-fallback=true: spawn-worker codex-spillover-* --model claude-opus-4-7
                       └─ emit codex_failover_dispatched
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
- **Name:** `codex-spillover-<timestamp>`
- **Model:** `claude-opus-4-7`
- **Lifetime:** task completes → `send-message <parent> normal "done: ..."` → `terminate-worker <name>`
- **Auth:** inherits local Max 20x OAuth from `~/.claude/.credentials.json` (`claudeAiOauth` key)

Prompts MUST end with the terminate-worker instruction — workers do not self-exit.

## Open Items

- **Task #5:** Greg to generate `ANTHROPIC_API_KEY_TEAM` from Team workspace console → `secrets.env` as `ANTHROPIC_API_KEY_TEAM` → activates spillover-2 on separate account for load-sharing
- **Task #6:** First production failover dry-run (analyst + dev) after #5
