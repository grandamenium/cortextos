# Wave-0/Wave-1 Session State — 2026-05-17 (update 2)

**Last saved:** 2026-05-17 ~17:30 EDT (auto-save during MacBook Claude session resume of `resume wave-0`)
**Resume code phrase:** `resume wave-0` — paste into any fresh Claude Code session on either machine

---

## Snapshot

```
MacBook (user: hari, host instance: default)
  daemon: PID varies, online, ecosystem.config.js generator is now HOME-portable
  agents: sam, warden-mb, pa (3 — correctly scoped via host field)
  HMAC key:  ~/.cortextos/default/config/bus-signing-key  — EXISTS, matches Mac mini
  daemon.env: ~/.cortextos/default/config/daemon.env — loaded by daemon at start (Task #76)
  enabled-agents.json: host fields added on all 17 entries
  Tailscale: 100.64.0.2, userspace networking, SOCKS5 localhost:1055
  installs: 25+ Week 1/2/3 packages under ~/installs (see /Users/hari/research/h1r9do/install/INSTALL-STATUS-2026-05-17.md)
  docker: qdrant (:6333), activepieces (:9580)

Mac mini (user: subbu_ai_assistant, host instance: default)
  daemon: should pick up new ecosystem generator + daemon.env loader on next pull
  agents: analyst, chief, dev, forge, research, research-codex, research-director, warden-mm (8)
  ACTION ON NEXT MAC MINI SESSION:
    1. git pull gitea
    2. npm run build && cortextos ecosystem --instance default
    3. Add ~/.cortextos/default/config/daemon.env (mirror MacBook)
    4. Update enabled-agents.json to add host: "subbu_ai_assistant@mac-mini" to local entries
    5. pm2 reload ecosystem.config.js --update-env
```

---

## Completed this session (`resume wave-0` invocation)

### Substrate (gitea/main commits)
| Commit | Tasks | Summary |
|---|---|---|
| b0cf213 | #74 #75 #76 | HOME-portable ecosystem + daemon.env loader + host-based agent scoping |
| 57e54ef | #62 #66 | agents.yaml runtime integration + typed bus contracts (29 new tests) |
| (pending) | #60 | restart circuit-breaker (module + alert refactor — integration into agent-process.ts in flight) |

### Wave-0 Tier-0 (auth resilience suite, in ~/.claude/)
- `/Users/hari/bin/claude-safe.sh` — auth-guarded Claude CLI wrapper (Task #53)
- `~/.claude/settings.json` — added SessionStart + PostToolUse JSON-lint hooks (Tasks #54, #56)
- `/Users/hari/cortextos/agents.yaml` — 11-agent capability manifest (Task #55)
- `~/.claude/skills/bootstrap/SKILL.md` — agent bootstrap sequence (Task #58)
- `~/.claude/skills/resume-registry/SKILL.md` — code-phrase registry (Task #59)

### Tier-3 install execution (h1r9do/INSTALL-QUEUE)
**Week 1 P0 — 16 packages installed + smoke-tested** (#67):
whisper.cpp (Metal), qdrant (docker), moonshine, whisperx, chatterbox, supertonic, agno, openai-agents, python-telegram-bot, twilio, fastembed, faster-whisper, pipecat, livekit-agents, stripe-agent-toolkit, playwright-mcp.

**Week 2 — 7 packages installed + smoke-tested** (#68):
mem0, browser-use, firecrawl, pydantic-ai, piper-tts, claude-agent-sdk, activepieces (docker on :9580).

**Week 3 partial — 3 packages installed** (#69 partial):
letta-client, mcp-memory-service, open-notebook.

**Deferred (need keys/scaffold)**:
- stagehand (OPENAI_API_KEY + interactive scaffold)
- open-saas (Stripe test key + Wasp scaffold + Postgres)
- chatterbox weights (3GB, lazy on first .from_pretrained call)
- whisperx pyannote weights (HF license acceptance + token)
- graphiti (needs Neo4j container — defer until use case)
- ruflo (alpha-eval gate: 7-day federation smoke test required FIRST)

## Tasks still pending after this session

| # | Task | Notes |
|---|---|---|
| 57 | Per-agent enabledPlugins scoping in daemon | Likely needs CLAUDE_CONFIG_DIR-per-agent or per-dir .claude/settings.json |
| 60 | Rate-limit circuit breaker | Module written; agent-process.ts integration pending (subagent in flight) |
| 61 | Convert top-5 Bash sequences to scripts/skills | bus/ already has 50+ scripts — the missing piece is /quick-bus skill consolidating dispatch |
| 63 | auth-doctor supervisor agent in cortextOS | Existing scripts/check-claude-auth.sh + scripts/refresh-claude-token.sh + bin/claude-safe.sh mostly cover this — needs daemon-side metrics surface |
| 64 | TDD autonomous loop tool | Heavy lift; design needed |
| 65 | parallel-swarm primitive (extract from h1r9do pattern) | Heavy lift; mine ~/research/h1r9do/_scripts for the 60-agent parallel pattern |
| 69 | ruflo alpha-eval gate | Real-world 7-day federation smoke test (not a code task) |
| 70 | Voice-PAaaS productization v1 | Pipecat + moonshine + supertonic end-to-end test + first customer signing |

## Manual rotations still pending (from earlier this session)
- 🔴 Rotate Anthropic OAuth token at console.anthropic.com → `claude` re-login → refresh-claude-token.sh propagates
- 🔴 Rotate Telegram bot 8640425235 via @BotFather → update sam/.env, warden-mb/.env, chief/.env
- 🟡 Rotate stdout.log + outbound-messages.jsonl AFTER token rotations
- 🟡 Configure git-credential osxkeychain helper (interactive password entry once)

## Key learnings this session

1. **PM2 env loader bug confirmed**: PM2 reads env ONLY from ecosystem.config.js — never from shell exports, never from external dotenv files. Task #76 (daemon.env) is the workaround.
2. **Subagent dispatch worked beautifully** for parallel substrate work + auth-resilience suite + Tier-3 installs. Three subagents ran ~simultaneously without collision because they touched non-overlapping file trees.
3. **Build is fast** (~35ms for tsup CJS bundle). Tests are slow (117s for full suite). Run targeted vitest for tight loops.
4. **Pre-existing test failures** in `agent-process-codex-app-server.test.ts` (4 tests) need cleanup — not caused by this session's work but blocking clean `npm test` exit.
5. **HMAC verifier deployed without incident** — 0 .errors growth across whole session.

## Resume protocol

When resuming in a fresh Claude Code session, paste:

```
resume wave-0

Read /Users/hari/cortextos/audits/2026-05-17-wave1/SESSION-STATE.md for full context.
Substrate (#74 #75 #76 #62 #66) complete on gitea/main. #60 circuit breaker module
written but agent-process.ts integration pending (check git status to see subagent
result). Install execution: Week 1 done, Week 2 done, Week 3 partial. Deferred items
need API keys / interactive scaffold. Tier-2 primitives (#57 #61 #63 #64 #65) all
still pending.

Pick up: either (a) complete #60 integration if not already done, or (b) start
#64 TDD-loop / #65 swarm primitive design work, or (c) execute deferred Tier-3
items if Hari has API keys ready.
```

On Mac mini just substitute `/Users/subbu_ai_assistant/cortextos/...` for the path.
