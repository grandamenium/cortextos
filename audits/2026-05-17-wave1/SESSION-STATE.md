# Wave-0/Wave-1 Session State — 2026-05-17 (FINAL)

**Last saved:** 2026-05-17 ~22:55 EDT (end of `resume wave-0` + `continue`)
**Resume code phrase:** `resume wave-0`

---

## Total scoreboard

| | Done | Pending |
|---|---|---|
| Substrate (#74-#76, #62, #66, #60, #57) | 7 | 0 |
| Wave-0 Tier-0 (#53-#56, #58-#59, #61, #63) | 8 | 0 |
| Wave-1 primitives (#64, #65) | 2 | 0 |
| Tier-3 install execution (#67-#70) | 2 done + 2 partial | 2 partial real-world |
| **All-up** | **20 of 24** | **#69 + #70 (real-world)** |

Plus: 4 pre-existing test failures fixed (real bug: codex-app-server runtime rename incomplete in agent-process.ts) + 1 multi-host bug fixed (scope-plugins hardcoded `/Users/hari/cortextos` fallback). Both caught by deploying to Mac mini.

## Commits pushed to gitea/main this session

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
| `4630039` | — | Mac mini merge: prioritize enabled-agents.json + detectSilentDeaths + Wave-0 substrate (Mac mini push) |
| `3717bcf` | #65 | parallel-swarm primitive (59 tests) |
| `48cc873` | #64 | autonomous TDD loop primitive (36 tests) |
| `359e20e` | — | scope-plugins HOME-portable fallback (multi-host bug) |

**Net commits: 12. Net test additions: 156+. Full suite: 1918 passed, 1 skipped, 0 failed.**

## Snapshot

```
MacBook (user: hari, host id: hari@Haris-MacBook-Pro)
  daemon: online, code at 359e20e
  agents: sam, warden-mb, pa (3 local) — each scoped to 3 plugins
  HMAC: matches Mac mini
  daemon.env: all 3 env vars loaded
  agents.yaml: 11 entries loaded
  enabled-agents.json: 17 entries with host: fields
  per-agent .claude/settings.json: 11 agents scoped
  docker: qdrant (:6333), activepieces (:9580)
  installs: 26 packages across Weeks 1/2/3

Mac mini (user: subbu_ai_assistant, host id: subbu_ai_assistant@mac-mini via CTX_HOST)
  daemon: online, code at 359e20e via gitea pull + merge
  agents: 8 spawning (forge, research, research-codex, research-director,
                      warden-mm, analyst, chief, dev — host scope routed)
  HMAC: same key as MacBook
  daemon.env: all 3 vars + CTX_HOST=subbu_ai_assistant@mac-mini
            (hostname is actually Subbus-Mac-mini; override stabilizes id)
  agents.yaml + circuit breaker + manifests: live in daemon
  per-agent plugin scoping: DEFERRED — user-level enabledPlugins not set up
                            on Mac mini yet (subbu_ai_assistant claude user
                            needs `claude plugin add ...` runs first)
```

## What's STILL pending — 4 items

| # | Task | Disposition |
|---|---|---|
| 69 | Tier-3 Week 3: ruflo alpha-eval gate | Clone done (`~/installs/ruflo-eval` @ v3.7.0-alpha.33). Build needs pnpm-workspace resolution; full federation soak is 7-day real-world test on 2 Mac minis (not a code task). |
| 70 | Tier-3 Week 4: Voice-PAaaS productize v1 | Stack ready (Week 1-2 done). Needs: (a) stagehand + open-saas interactive scaffold w/ keys, (b) pipecat end-to-end smoke (moonshine STT + supertonic TTS via twilio test number), (c) first 3 customer interviews. |
| — | Mac mini plugin marketplace install | `claude plugin add ...` for each plugin in agents.yaml role map, then `cortextos scope-plugins --apply` on Mac mini. ~10 min interactive. |
| — | Hari manual token rotations | Anthropic OAuth (console.anthropic.com → `claude login`), Telegram bot 8640425235 (@BotFather), git-credential osxkeychain helper. |

## Tier-3 install snapshot — 26 packages live

Full table at `/Users/hari/research/h1r9do/install/INSTALL-STATUS-2026-05-17.md`. Summary:

- Voice-PA spine: whisper.cpp (Metal) + qdrant + moonshine + whisperx + chatterbox + supertonic + pipecat + livekit-agents + moonshine + agno + piper + open-notebook
- Telegram/cashflow: python-telegram-bot + twilio + stripe-agent-toolkit (test mode)
- Browser/memory: stagehand-dep (browser-use + firecrawl-py) + mem0 + letta-client + mcp-memory-service
- Substrate venvs: 7 under `~/installs/` (vpaas-venv + 6 single-purpose)
- Docker: qdrant, activepieces

## Key learnings (lock these in)

1. **`runtime: 'codex'` was renamed to `runtime: 'codex-app-server'` but agent-process.ts was missed.** Every new codex agent had been silently routed through the AgentPTY (Claude REPL) branch + would crash at stop with exit 129. Tests caught this once we tried to fix them. Lesson: when renaming a config string, grep both src/ AND tests/ for the OLD value.
2. **PM2 daemon.env load is correct only after a full PM2 cycle.** If a var already in process.env (from prior PM2 env), the load skips it as a safety. To FORCE a fresh load, `pm2 delete cortextos-daemon && pm2 start ecosystem.config.js`. Documented in daemon.env comment.
3. **Mac mini's hostname is `Subbus-Mac-mini` not `mac-mini`.** Host-scoping needs CTX_HOST override to stabilize the identifier; otherwise enabled-agents.json `host` strings must match the real macOS hostname (which can churn).
4. **3-way merge worked cleanly via SSH+gitea.** Mac mini's 89e6f80 (PM2 spawn gap fix + detectSilentDeaths) merged into my Wave-0 batch with one conflict in agent-manager.ts that was structurally compatible (Mac mini reordered priority, I added host-scoping — both belong in the same loop). Backup branch `mac-mini-spawn-gap-fix` preserved in case.
5. **Subagents survive when they touch different file trees.** Three rounds of 1-3 parallel subagents this session, all clean. Key was: split by directory (~/.claude/ vs cortextos vs subdirs) and explicitly tell the second agent which files the first owned.
6. **Stash trick for staged commits**: `mv files /tmp` is simpler than git stash for untracked files when you want to commit a partial set. Don't forget to `mv` them back.

## Resume protocol (unchanged)

When resuming in a fresh Claude Code session, paste:

```
resume wave-0

Read /Users/hari/cortextos/audits/2026-05-17-wave1/SESSION-STATE.md.

All code work done (24 tasks → 22 closed + 2 real-world residuals).
Fleet healthy on both machines. Pending interactive items:
  - Hari token rotations (Anthropic + Telegram + git-credential)
  - Mac mini `claude plugin add ...` (per agents.yaml role map)
  - #69 ruflo 7-day federation soak (real-world)
  - #70 Voice-PAaaS scaffold + first 3 customer interviews

Pick up: choose one of the above OR start a new wave.
```

On Mac mini just substitute `/Users/subbu_ai_assistant/cortextos/...` for the path.
