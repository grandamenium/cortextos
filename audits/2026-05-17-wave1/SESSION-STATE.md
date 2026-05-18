# Wave-0/Wave-1 Session State — 2026-05-17 (TRULY final)

**Last saved:** 2026-05-17 ~23:18 EDT (end of resume wave-0 + continue + continue)
**Resume code phrase:** `resume wave-0`

## Scoreboard

| | Done | Real-world residual |
|---|---|---|
| Substrate (#74-#76, #62, #66, #60, #57) | 7 | — |
| Wave-0 Tier-0 (#53-#56, #58-#59, #61, #63) | 8 | — |
| Wave-1 primitives (#64, #65) | 2 | — |
| Tier-3 install (#67-#70) | 2 done + 2 install/scaffold done | 2 real-world (7-day soak + customer signing) |
| Multi-host hardening | 1 mega-command + 3 conformance tests | — |
| Pre-existing test debt cleanup | 4 failures fixed (incl. 1 real prod bug) | — |
| **Tasks all-up** | **22 of 24** | **#69 + #70 real-world** |

## Commits pushed to gitea/main (16 in this Wave-1)

| SHA | Tasks | Title |
|---|---|---|
| `b0cf213` | #74 #75 #76 | HOME-portable ecosystem + daemon.env loader + host scoping |
| `57e54ef` | #62 #66 | agents.yaml runtime integration + bus contracts (29 tests) |
| `cc71c15` | — | session state update 1 |
| `edbcdbf` | #60 | restart circuit breaker for 401/429 storms (16 tests) |
| `10609d3` | — | gitignore dashboard/PORT=* |
| `71a5fb7` | #57 | scope-plugins CLI per-agent enabledPlugins (21 tests) |
| `448d6b3` | — | session state update 2 |
| `c8a8ace` | — | fix 4 pre-existing test failures + complete codex-app-server runtime rename (real bug) |
| `4630039` | (Mac mini merge) | Mac mini's spawn-gap fix + detectSilentDeaths + Wave-0 substrate |
| `3717bcf` | #65 | parallel-swarm primitive (59 tests) |
| `48cc873` | #64 | autonomous TDD loop primitive (36 tests) |
| `359e20e` | — | scope-plugins HOME-portable fallback (multi-host bug) |
| `4fe8404` | — | session state v3 |
| `412dad3` | (#69 install) | ruflo alpha-eval runbook |
| `9bafdd8` | — | cortextos status mega-command + multi-host conformance tests (8 tests) |
| `a3d860c` | — | move multi-host doc into tracked audits/ |

**Net new test additions: 164+. Full suite: 1926 passed, 1 skipped, 0 failed across 117 files (was 4 failed / 1819 at session start).**

## Snapshot

```
MacBook (user: hari, host id: hari@Haris-MacBook-Pro)
  daemon: online, code at a3d860c
  agents: sam, warden-mb, pa (3 local) — scoped to 3 plugins each
  HMAC: matches Mac mini (sha256 fingerprint in `cortextos status`)
  daemon.env: 3 env vars loaded
  agents.yaml: 11 entries loaded
  enabled-agents.json: 17 entries with host: fields
  per-agent .claude/settings.json: 11 agents scoped via scope-plugins
  docker: qdrant (:6333), activepieces (:9580)
  installs: 26+ packages across Weeks 1/2/3 + voice-PA demo at ~/voice-pa-demo/

Mac mini (user: subbu_ai_assistant, host id (override): subbu_ai_assistant@mac-mini)
  daemon: online, code at a3d860c
  agents: 12 running (analyst, blueteam, chief, dev, forge, research,
                       research-codex, research-director, security-vp,
                       warden-mm, redteam, home-net — 4 are NOT in
                       agents.yaml: status drift correctly flagged)
  HMAC: same as MacBook
  daemon.env: all vars + CTX_HOST override (real hostname is Subbus-Mac-mini)
  per-agent plugin scoping: DEFERRED — needs `claude plugin add ...` first
                            (subbu_ai_assistant user hasn't installed plugins)
```

## What's NEW vs SESSION-STATE.md before this "continue" round

- **#65 swarm primitive** — `cortextos swarm run|status|collect|reconcile`. Fan items across worker(s), persist JSONL, reconcile multi-model agreement. 59 tests.
- **#64 TDD loop primitive** — `cortextos tdd-loop --spec`. Read spec → write tests → run → fix → loop. JSONL iteration log + resume. 36 tests.
- **Pre-existing test failures fixed (4 → 0)** + real codex-app-server runtime rename bug closed.
- **Mac mini fully merged + healthy** — 3-way merge of Mac mini's spawn-gap fix + my Wave-0 substrate; built + reloaded + 12 agents running.
- **HOME-portable scope-plugins bug fixed** (caught by deploying to Mac mini).
- **`cortextos status` mega-command** — one-shot fleet health view (host + daemon + agents+roles + bus + breaker + HMAC + manifest drift + crashes). Live verified on BOTH hosts.
- **Multi-host conformance test** — 3 static-analysis checks that fail if you re-introduce the hardcoded-path or incomplete-rename patterns.
- **Voice-PA end-to-end demo** at `/Users/hari/voice-pa-demo/` — JFK sample → moonshine STT (885ms) → openai-agents stub (15ms) → supertonic TTS (1748ms) = 13.2s total wall clock. Proves the local stack works end-to-end. No twilio yet.
- **ruflo installed + smoke-tested** via `npm install -g claude-flow@alpha` → v3.7.0-alpha.67. Two alpha-quality issues caught (memory backend not persisting, federation plugin not bundled). Full eval runbook at audits/RUFLO-EVAL-RUNBOOK.md.
- **Multi-host doc + lessons** — `audits/2026-05-17-wave1/MULTI-HOST.md` + CLAUDE.md pointer + Hari's auto-memory updated with `cortextos_wave1_complete.md` + `feedback_multi_host_first.md`.

## What's STILL pending — 4 items, all real-world

| # | Task | Disposition |
|---|---|---|
| 69 | ruflo alpha-eval gate | Install + smoke-test done; 7-day federation soak needs Hari to install the federation plugin + run sam ↔ analyst over Tailscale for a week. Full procedure in `audits/RUFLO-EVAL-RUNBOOK.md`. |
| 70 | Voice-PAaaS productize v1 | Pipeline works end-to-end at `/Users/hari/voice-pa-demo/`. Needs (a) wire to twilio test number for real PSTN, (b) sign first 3 customers. |
| — | Hari manual rotations | Anthropic OAuth (console.anthropic.com → `claude login`), Telegram bot 8640425235 (@BotFather), git-credential osxkeychain. |
| — | Mac mini `claude plugin add ...` | Per agents.yaml role map, then `cortextos scope-plugins --apply`. ~10 min interactive. |

## How to operate this fleet now

- **One-shot health:** `cortextos status` (add `--json` for machine output, `--instance <id>` to switch instances)
- **Pre-merge check:** `npx vitest run tests/unit/multi-host-conformance.test.ts`
- **Bootstrap an agent session:** invoke `/bootstrap` skill
- **Find a code phrase:** invoke `/resume-registry` skill
- **Audit auth health:** invoke `/auth-doctor` skill
- **Bus operations cheatsheet:** invoke `/quick-bus` skill
- **Parallel work:** `cortextos swarm run --input ... --prompt ... --model claude-sonnet`
- **Autonomous TDD:** `cortextos tdd-loop --spec <spec.md>`
- **Per-agent plugin gate:** `cortextos scope-plugins --dry-run` then `--apply`

## Resume protocol

```
resume wave-0

Read /Users/hari/cortextos/audits/2026-05-17-wave1/SESSION-STATE.md.

22 of 24 Wave-1 tasks closed across 16 commits. Both fleets healthy
(MacBook 3 agents, Mac mini 12 agents). Pending interactive items:
  - Hari token rotations (Anthropic + Telegram + git credential)
  - Mac mini `claude plugin add ...` (per agents.yaml role map) then scope-plugins --apply
  - #69 ruflo 7-day federation soak (runbook at audits/RUFLO-EVAL-RUNBOOK.md)
  - #70 Voice-PAaaS twilio wire-up + first customer signing (demo works at ~/voice-pa-demo/)

Pick up: any of the above, OR start a new wave.
```
