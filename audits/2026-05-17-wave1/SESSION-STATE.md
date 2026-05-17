# Wave-0/Wave-1 Session State — 2026-05-17 (final)

**Last saved:** 2026-05-17 ~17:40 EDT (end-of-session save)
**Resume code phrase:** `resume wave-0` — pasted into any fresh Claude Code session on either machine

---

## What landed this session — `resume wave-0` invocation

### Commits pushed to gitea/main (cortextOS repo)
| SHA | Tasks | Title |
|---|---|---|
| `b0cf213` | #74 #75 #76 | HOME-portable ecosystem + daemon.env loader + host-based agent scoping |
| `57e54ef` | #62 #66 | agents.yaml runtime integration + typed bus contracts (29 new tests) |
| `cc71c15` | — | docs: session state update |
| `edbcdbf` | #60 | per-agent restart circuit breaker for 401/429 storms (16 new tests) |
| `10609d3` | — | chore: gitignore stray dashboard/PORT=* files |
| `71a5fb7` | #57 | scope-plugins CLI — per-agent enabledPlugins subset (21 new tests) |

**66 new unit tests added across the substrate work** — all green; the 4 pre-existing failures (`agent-process-codex-app-server.test.ts`, `add-agent-template-parity.test.ts`) are unrelated and need a separate cleanup pass.

### Wave-0 Tier-0 auth-resilience suite (~/.claude/ and ~/bin/)
- `/Users/hari/bin/claude-safe.sh` — auth-guarded Claude CLI wrapper (#53)
- `~/.claude/settings.json` — SessionStart auth check + PostToolUse JSON-lint hooks (#54 #56)
- `/Users/hari/cortextos/agents.yaml` — 11-agent capability manifest (#55)
- `~/.claude/skills/bootstrap/SKILL.md` — agent bootstrap sequence (#58)
- `~/.claude/skills/resume-registry/SKILL.md` — code-phrase registry (#59)
- `~/.claude/skills/quick-bus/SKILL.md` — canonical bus operation shortcuts (#61)
- `~/.claude/skills/auth-doctor/SKILL.md` — auth-health observable surface (#63)

### Per-agent plugin scoping applied (#57)
`cortextos scope-plugins --apply` ran successfully. All 11 MacBook agents now load only role-relevant plugins:
- sam, pa: telegram + imessage + fakechat (3 plugins, was 60+)
- forge: chrome-devtools-mcp, expo, microsoft-docs, mongodb, pinecone (5 plugins)
- warden-mb: fewer-permission-prompts + simplify + hookify (3 plugins)
- (etc — see `cortextos scope-plugins --dry-run` for the role table)

Each agent's per-dir `.claude/settings.json` lives under `orgs/subbu-ops/agents/<name>/.claude/` (gitignored — operator-specific). Agents have been restarted; new scoping is live.

### Tier-3 install execution (h1r9do INSTALL-QUEUE)

Full status: `/Users/hari/research/h1r9do/install/INSTALL-STATUS-2026-05-17.md`

**Week 1 P0 (#67)** — 16 packages installed + smoke-tested:
whisper.cpp (Metal), qdrant (docker :6333), moonshine, whisperx, chatterbox, supertonic, agno, openai-agents, python-telegram-bot, twilio, fastembed, faster-whisper, pipecat, livekit-agents, stripe-agent-toolkit, playwright-mcp (pinned earlier in B2).

**Week 2 (#68)** — 7 more packages:
mem0, browser-use, firecrawl-py, pydantic-ai, piper-tts, claude-agent-sdk, activepieces (docker :9580).

**Week 3 partial (#69 in-progress)** — 3 more: letta-client, mcp-memory-service, open-notebook. Full #69 closure needs the 7-day ruflo federation smoke-test.

**Deferred — need interactive scaffold/API keys:**
- stagehand (OPENAI_API_KEY + `npx create-browser-app`)
- open-saas (Stripe test key + Wasp scaffold + Postgres)
- chatterbox/whisperx model weights (HF login + license accept)
- graphiti (Neo4j container)
- ruflo (alpha-eval gate)

---

## Snapshot

```
MacBook (user: hari)
  daemon: online, ecosystem.config.js generator is now HOME-portable
  agents running: sam, warden-mb, pa (3 local, each scoped to relevant plugins)
  HMAC key:   ~/.cortextos/default/config/bus-signing-key  — matches Mac mini
  daemon.env: ~/.cortextos/default/config/daemon.env — loaded at startup (#76)
  manifest:   /Users/hari/cortextos/agents.yaml — loaded at startup (#62)
  enabled-agents.json: 17 entries with host: fields (#75)
  per-agent .claude/settings.json: 11 agents scoped (#57)
  daemon health: 0 bus errors, ~7 restarts (normal)
  installs:   25+ Week 1/2/3 packages under ~/installs
  docker:     qdrant (:6333), activepieces (:9580)

Mac mini (user: subbu_ai_assistant)
  daemon: needs `git pull && npm run build && cortextos ecosystem --instance default` to pick up substrate
  PLUS: copy daemon.env, update enabled-agents.json with host fields, run scope-plugins --apply
```

---

## Tasks STILL pending (for next session or interactive operator)

| # | Task | Disposition |
|---|---|---|
| 64 | TDD autonomous loop tool | Heavy lift — DESIGN NEEDED. Defer to next session. |
| 65 | Extract parallel-swarm primitive from h1r9do pattern | Heavy lift — mine `~/research/h1r9do/_scripts` for the 60-agent pattern, distill into cortextOS worker-process primitive |
| 69 | ruflo alpha-eval gate | Real-world 7-day federation smoke-test. Install ruflo on Mac mini, run sam-mini ↔ pa-mini federation for 7 days, log issues. Not a code task. |
| 70 | Voice-PAaaS productize v1 | Stack is ready (Week 1-2 done). Needs: (a) open-saas + stagehand interactive scaffold, (b) pipecat-end-to-end smoke (moonshine STT + supertonic TTS via twilio test number), (c) first 3 customer interviews |

## Manual rotations still pending (from earlier this session)
- 🔴 Rotate Anthropic OAuth token at console.anthropic.com → `claude` re-login → refresh-claude-token.sh propagates
- 🔴 Rotate Telegram bot 8640425235 via @BotFather → update sam/.env, warden-mb/.env, chief/.env
- 🟡 Rotate stdout.log + outbound-messages.jsonl AFTER token rotations
- 🟡 Configure git-credential osxkeychain helper (interactive password entry once)

## Mac mini sync checklist (do on next Mac mini session)
```bash
cd ~/cortextos
git pull gitea main
npm install && npm run build
cortextos ecosystem --instance default     # regenerates with HOME paths
# Mirror MacBook's daemon.env:
cat > ~/.cortextos/default/config/daemon.env <<'EOF'
CTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z
CTX_REQUIRE_EXPLICIT_ENABLE=1
CTX_DEBUG_ALLOW_CRASH_TRIGGER=0
EOF
# Edit enabled-agents.json to add `host: "subbu_ai_assistant@mac-mini"` to all entries
# Apply per-agent plugin scoping (won't touch your local user settings):
cortextos scope-plugins --apply
pm2 reload ecosystem.config.js --update-env
```

## Key learnings this session (lock these in)

1. **PM2 env loader limitation**: PM2 reads env ONLY from ecosystem.config.js — never shell exports, never external dotenv. daemon.env loader (Task #76) is the canonical workaround.
2. **Parallel subagents WORK**: Three subagents ran ~simultaneously (auth resilience + substrate + Tier-3 installs + later #57/#61/#63) without collisions because they touched non-overlapping file trees.
3. **Per-agent plugin scoping is a major context win**: Cuts sam's loaded plugin surface from 60+ to 3. That's tokens-per-turn saved permanently.
4. **uv venv per voice-stack package** is the right pattern — PyTorch versions conflict, so isolate.
5. **Pre-existing test failures must be cleaned up**: `agent-process-codex-app-server.test.ts` and `add-agent-template-parity.test.ts` block clean `npm test`. Not blocking new work but worth a follow-up pass.

## Resume protocol

When resuming in a fresh Claude Code session, paste:

```
resume wave-0

Read /Users/hari/cortextos/audits/2026-05-17-wave1/SESSION-STATE.md for full context.
This session closed: substrate (#74-#76) + Wave-0 Tier-0 (#53-#59) + agents.yaml/bus
contracts (#62/#66) + circuit breaker (#60) + per-agent plugin scoping (#57) +
auth-doctor/quick-bus skills (#61/#63) + Tier-3 Week 1+2 install execution (#67/#68).

REMAINING work:
  - #64 TDD autonomous loop tool (heavy lift, design needed)
  - #65 parallel-swarm primitive (extract from h1r9do pattern)
  - #69 ruflo alpha-eval gate (7-day real-world federation smoke test)
  - #70 Voice-PAaaS productize (open-saas scaffold + first 3 customer interviews)

Plus: 🔴 Hari manual rotations (Anthropic + Telegram tokens), 🟡 Mac mini sync (see
checklist in SESSION-STATE.md), 🟡 pre-existing test failures cleanup.

Pick up: choose #64 (build the TDD loop primitive), #65 (build swarm CLI primitive),
or interactive #70 (Voice-PAaaS scaffold + customer signing).
```

On Mac mini just substitute `/Users/subbu_ai_assistant/cortextos/...` for the path.
