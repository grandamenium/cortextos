# Wave-0/Wave-1 Session State — 2026-05-17

**Last saved:** 2026-05-17 ~16:30 EDT (auto-save during MacBook Claude session, ~67% context)
**Resume code phrase:** `resume wave-0` — pasted into any fresh Claude Code session on either machine

---

## Current fleet state (as of save)

```
MacBook (user: hari, host instance: default)
  daemon: PID 37718, online, ecosystem.config.js LOCAL-PATCHED (Mac-mini paths→hari paths)
  agents: sam, warden-mb, pa (3 — correctly scoped)
  HMAC key:  ~/.cortextos/default/config/bus-signing-key  — MISSING (still)
  Tailscale: 100.64.0.2, userspace networking, SOCKS5 localhost:1055
  
Mac mini (user: subbu_ai_assistant, host instance: default)
  daemon: PID 25357 region, online, ecosystem.config.js canonical
  agents: analyst, chief, dev, forge, research, research-codex, research-director, warden-mm (8)
  HMAC key:  ~/.cortextos/default/config/bus-signing-key  — EXISTS (64-byte hex, mode 0600, mtime 2026-05-07)
  Node:      /Users/subbu_ai_assistant/.local/bin/{node,npm,pm2}  (not in default PATH via ssh — set PATH manually)
```

---

## Substrate work done this session

1. **Tailscale fix on Mac mini** — plist socket arg `/var/run/tailscaled.socket` → `/Users/subbu_ai_assistant/.config/tailscaled/tailscaled.sock`. Done by Mac mini Claude. Mac mini now reachable on tailnet.
2. **MacBook→Mac mini SSH** — dedicated ed25519 key at `~/.ssh/id_ed25519_mac_mini` + `~/.ssh/config` host `mac-mini` (uses SOCKS5 proxy via ProxyCommand). Public key in `subbu_ai_assistant@mac-mini:~/.ssh/authorized_keys`.
3. **Git divergence reconciled** — MacBook 6-ahead + Mac mini 670c47f detached + gitea/main 2f3c416 → merged on feature branch `feat/macbook-md3-reliability-2026-05-17` → fast-forward pushed to `gitea/main` at SHA `0e1a460`.
4. **Conflicts resolved** (during merge): ecosystem.config.js, scripts/bus-relay/bus-relay.sh, src/daemon/agent-process.ts (with CodexPTY→CodexAppServerPTY rename), src/daemon/fast-checker.ts.
5. **Build fixes**: tsup.config.ts orphan `hook-episodic-post-tool` entry removed.
6. **[WIP] dashboard auth security regression reverted** before main push.
7. **Both daemons restarted** via `pm2 reload ecosystem.config.js --update-env` (regular `restart` doesn't pick up new env vars).
8. **enabled-agents.json scoped manually** on both machines to prevent cross-host duplicate spawning (sam on Mac mini ate Telegram polling for the few minutes it ran).

---

## Surprises caught + lessons learned

| Surprise | Lesson |
|---|---|
| Mac mini Claude refused my `openssl rand` proposal because key already existed | Always verify before generating randomness — destroying a running HMAC key kills all bus messaging |
| Userspace tailnet means plain `curl http://100.64.0.1:X/` fails — needs SOCKS5 proxy at localhost:1055 | Configure git remote with `http.<url>.proxy socks5h://localhost:1055` |
| `pm2 restart` keeps OLD env; need `pm2 reload --update-env` to load new ecosystem.config.js vars | Use `reload`, not `restart`, after ecosystem changes |
| ecosystem.config.js with hardcoded user paths broke on host with different user | Use HOME-based / variable-based paths; tracked as Task #74 |
| enabled-agents.json `status` field is ignored by daemon — only `enabled: true/false` is checked | Manually scope per-host until status enforcement is added; tracked as Task #75 |
| tsup.config.ts had orphan reference to never-committed `hook-episodic-post-tool.ts` | Pre-existing gitea bug — removed from entry list with comment |
| SSH to Mac mini drops user PATH — node/npm/pm2 at `~/.local/bin/` not in PATH | Always prepend `export PATH="$HOME/.local/bin:$PATH"` |
| MacBook's old tailscale.err.log spam was just "can't reach Mac mini" — benign once Mac mini back | Not all log growth is a bug |
| Three different commits across MacBook, Mac mini, gitea/main — true 3-way divergence | Establish gitea as canonical NOW so this never recurs |

---

## What's STILL TODO (in order)

### ~~B1: bus HMAC reconciliation + verifier fail-closed~~ ✅ COMPLETE 2026-05-17

- Key copied MacBook ← Mac mini via scp. sha256 verified identical (`b9a175c7e7f0...`)
- `src/bus/message.ts` patched: `withinAuthGracePeriod()` helper + verifier fail-closed when key present + sig missing post-grace; commit `10bc8bd` on `gitea/main`
- Grace window: `CTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z` (24h migration window). Embedded in ecosystem.config.js env block on both machines (NOT in daemon.env — PM2 ignores that path)
- Both daemons reloaded via `pm2 reload ecosystem.config.js --update-env`
- Verified end-to-end: MacBook receiving signed msgs from Mac mini's research-codex (sig=YES), Mac mini receiving signed msgs from dev (sig=YES), 0 `.errors` growth post-deploy

**Lesson learned:** PM2 only reads env from ecosystem.config.js (not from shell exports, not from daemon.env file). For per-instance env vars, either embed in ecosystem.config.js OR add daemon-side loader for daemon.env (better — Task #76).

**Grace window expires 2026-05-18T20:20:49Z** — after that, unsigned messages will be dropped to .errors/. By then all running agents have restarted and are signing.

### B2: serena + 4 plugin commit-SHA pinning
- Pick known-good serena commit SHA from https://github.com/oraios/serena/commits/main
- Patch `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/serena/.mcp.json` on BOTH machines
- Same for: playwright, firebase, context7 (npm @latest → pinned version)
- Audit remaining 11 plugins for `@latest`/`HEAD` patterns
- Each plugin .mcp.json is per-machine — must patch both sides

### B3: token rotation + redact.ts patch + .env.bak scrub
- **Hari manual:** rotate Anthropic OAuth token at console.anthropic.com (via `claude` re-login on MacBook)
- **Hari manual:** rotate Telegram bot 8640425235 via @BotFather
- **Auto:** patch `src/pty/redact.ts` to catch `sk-ant-oat01-*`, `sk-ant-api03-*`, telegram bot tokens, Bearer headers (currently only JWT)
- **Auto:** patch `src/telegram/api.ts:597` to strip token from URL in error message
- **Auto:** scrub `.env.bak.*` on both machines (`rm` after Hari confirms rotation)
- **Auto:** rotate `~/.cortextos/default/logs/sam/stdout.log` + `outbound-messages.jsonl` (contain old token traces)
- **Auto:** chmod 0600 on all current `.env` files
- **Auto:** add `.env.bak.*` to `.gitignore` on both machines (currently only `.env` is ignored)
- **Auto:** replace plaintext gitea password in `.git/config` with SSH key OR `git-credential` helper

### Follow-ups in task list (#74, #75)
- ecosystem.config.js HOME-based paths (committed fix)
- agent-manager.ts: enforce `status` field in enabled-agents.json so daemons skip cross-host agents automatically

### Tier 0/1/2/3 (the broader 100x roadmap, tasks #53-70)
- Still pending — substrate sync was the prereq. Now flows cleanly via git.

---

## Key paths + commands you'll need to remember

```bash
# SSH to Mac mini (works from MacBook, uses SOCKS5 ProxyCommand from ~/.ssh/config)
ssh mac-mini 'whoami'   # subbu_ai_assistant

# Mac mini PATH setup for any pm2/node command
ssh mac-mini 'export PATH="$HOME/.local/bin:$PATH" && pm2 list'

# gitea via SOCKS5 (already configured in ~/.gitconfig local for cortextos repo)
git fetch gitea

# pm2 reload (not restart) after ecosystem changes
pm2 reload ecosystem.config.js --update-env

# Check current agent count under daemon
DP=$(pm2 jlist | python3 -c "import sys,json; [print(a['pid']) for a in json.load(sys.stdin) if a['name']=='cortextos-daemon']")
pgrep -P $DP | wc -l
```

## Resume protocol

When resuming in fresh Claude Code session, paste:

```
resume wave-0

The MacBook + Mac mini cortextOS fleet substrate sync was completed 2026-05-17.
Both daemons running merged code (gitea/main at 0e1a460). 
Read /Users/hari/cortextos/audits/2026-05-17-wave1/SESSION-STATE.md for full context.
Pick up from the "STILL TODO" list — start with B1 (bus HMAC) unless I tell you otherwise.
```

---

*This file lives in git at audits/2026-05-17-wave1/SESSION-STATE.md — committed before context expiry.*
