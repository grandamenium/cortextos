---
name: agent-management
description: "You need to create a new agent, restart a crashed agent, change an agent's model or config, fix a Telegram bot token, troubleshoot why an agent is not responding, enable or disable an agent, spawn an agent for another user, manage PM2 process management, reset crash limits, or do anything that touches an agent's lifecycle, configuration, or credentials. This is the definitive guide for every agent operation in cortextOS."
triggers: ["new agent", "create agent", "spawn agent", "add agent", "restart", "soft restart", "hard restart", "disable agent", "enable agent", "change model", "switch model", "bot token", "BotFather", "agent not responding", "agent crashed", "agent down", "crash limit", "reset crashes", "agent health", "list agents", "heartbeat", "onboard", "setup agent", "configure agent", ".env", "config.json", "pm2", "ecosystem.config", "cross-org", "agent for someone else", "agent management", "agent lifecycle", "agent credentials", "telegram bot", "token not working"]
external_calls: ["api.telegram.org"]
---

# Agent Management

> The definitive guide for managing cortextOS agent lifecycle. Every operation, every script, every protocol. Follow these EXACTLY - do not improvise.

---

## CRITICAL RULES

1. **ALWAYS use the CLI.** Never manually edit state files or .env without using the proper command.
2. **ALWAYS create .env before enabling.** An agent without .env will inherit parent credentials (the Becky bug).
3. **ALWAYS write restart markers before /exit.** Use `cortextos bus self-restart`, never raw /exit.
4. **ALWAYS use `cortextos enable` to start agents.** Never manually edit PM2 config.
5. **NEVER share bot tokens between agents.** Each agent gets its own bot from @BotFather.
6. **NEVER hardcode chat IDs.** Get them from the actual user via Telegram getUpdates.
7. **ALWAYS ask the user which runtime** (claude-code vs codex-app-server) before scaffolding a new agent. Default to claude-code only if the user has no preference. Never silently pick.

---

## 1. Creating a New Agent

### For Yourself (Same User)

```bash
# Option A: CLI (recommended)

# STEP 0 — REQUIRED BEFORE SCAFFOLDING — Ask the user which runtime:
#   "Should this agent run on Claude Code (Anthropic) or Codex (OpenAI gpt-5-codex)?"
# Default to claude-code if the user has no preference. Never silently pick.
# Codex agents MUST use the agent-codex template; orchestrator/analyst/m2c1-worker
# do not have codex variants — the CLI will reject the mismatch.

# claude-code path (the common one):
cortextos add-agent <name> --template agent --org <org> --runtime claude-code

# codex-app-server path (gpt-5-codex via codex CLI app-server JSONRPC):
cortextos add-agent <name> --template agent-codex --org <org> --runtime codex-app-server

# Option B: Manual
TEMPLATE="agent"  # or "orchestrator" or "analyst"
AGENT_NAME="myagent"
ORG="myorg"

# Step 1: Copy template
cp -r "$CTX_FRAMEWORK_ROOT/templates/$TEMPLATE" \
      "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME"

# Step 2: Create Telegram bot
# Tell the user:
# 1. Open Telegram, message @BotFather
# 2. Send /newbot
# 3. Choose a name (e.g., "My Agent")
# 4. Choose a username (e.g., myagent_cortextos_bot)
# 5. Copy the bot token

# Step 3: Get chat ID
# Tell the user:
# 1. Send any message to the new bot
# 2. Run: curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
# 3. That number is the chat_id

# Step 4: Get user ID (for ALLOWED_USER security)
# Same getUpdates response: .result[0].message.from.id

# Step 5: Write .env (CRITICAL - do this BEFORE cortextos enable)
cat > "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME/.env" << EOF
BOT_TOKEN=<token from BotFather>
CHAT_ID=<chat_id from getUpdates>
ALLOWED_USER=<user_id from getUpdates>
EOF
chmod 600 "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME/.env"

# Step 6: Update config.json
node -e "
const fs = require('fs');
const path = '$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME/config.json';
const c = JSON.parse(fs.readFileSync(path));
c.agent_name = '$AGENT_NAME';
c.enabled = true;
fs.writeFileSync(path, JSON.stringify(c, null, 2));
"

# Step 7: Enable agent (registers with daemon)
cortextos enable "$AGENT_NAME" --org "$ORG"

# Step 8: Verify
cortextos status
```

### For Another Person (Cross-User Agent)

```bash
AGENT_NAME="theiragent"
ORG="myorg"
THEIR_BOT_TOKEN="<token from THEIR BotFather bot>"
THEIR_CHAT_ID="<THEIR chat_id, NOT yours>"
THEIR_USER_ID="<THEIR user_id>"

# Step 1: Add agent via CLI
cortextos add-agent "$AGENT_NAME" --template agent --org "$ORG"

# Step 2: Write THEIR .env (CRITICAL - must be THEIR credentials)
cat > "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME/.env" << EOF
BOT_TOKEN=$THEIR_BOT_TOKEN
CHAT_ID=$THEIR_CHAT_ID
ALLOWED_USER=$THEIR_USER_ID
EOF
chmod 600 "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME/.env"

# Step 3: Enable
cortextos enable "$AGENT_NAME" --org "$ORG"

# VERIFY: The new agent messages THEM, not you
# If messages come to you instead of them, the .env has wrong CHAT_ID
```

**Common Mistake (Becky Bug):** If you skip the .env creation, the agent inherits YOUR credentials from the parent environment. Messages meant for the other user go to YOU instead. ALWAYS create .env BEFORE enabling.

---

## 2. Restarting Agents

### Soft Restart (Preserves Conversation)

```bash
# Via bus command (preferred — writes marker file automatically)
cortextos bus self-restart --reason "<reason>"

# Restart a DIFFERENT agent
cortextos bus send-message <agent_name> high "soft-restart" "<reason>"
```

**What it does:**
1. Writes `.user-restart` marker (prevents false crash alert)
2. Sends /exit (Claude exits gracefully)
3. Daemon detects exit, finds marker, categorizes as "user_initiated"
4. Daemon relaunches with --continue (preserves conversation history)

### Hard Restart (Fresh Session, Loses History)

```bash
cortextos bus hard-restart --reason "context exhaustion"
```

**When to use:** Context window full, conversation corrupted, need clean slate, or wiring a new hook (see Hook Reload Lifecycle below). Hard-restart sends an IPC `restart-agent` signal to the daemon, which kills the running PID and respawns it fresh. The respawn consumes the `.force-fresh` marker and skips `--continue`, so `settings.json` (including newly-wired hooks) is re-read from scratch.

### Hook Reload Lifecycle

`.claude/settings.json` hooks (PreToolUse, PostToolUse, Stop, SessionStart, etc) are loaded once when the Claude CLI process starts. They are NOT reloaded by `cortextos bus self-restart` — soft restart relaunches Claude with `--continue`, which reuses the existing process settings cache. Project-level hooks added or changed in `settings.json` since the original boot DO NOT take effect under soft restart.

**When wiring a new hook to a running agent, use a hard restart, not a soft restart:**

```bash
# From inside the agent itself, or from another agent/terminal:
cortextos bus hard-restart --reason "loading new hook"

# Equivalent ops-side path:
cortextos stop <agent> && cortextos start <agent>
```

Both kill the existing PID and respawn a fresh process that re-reads `settings.json` from scratch. Verify by adding a one-line debug write to your hook script before testing — if the file shows up after a benign tool call, the hook is loaded.

This bit us hard on the coder-telegram-guardrail wire-up before upstream PR #217 fixed `bus hard-restart` to actually signal the daemon. On any fork that has not pulled in #217 (commit `a38ef7a`), `bus hard-restart` writes markers without killing the PID — fall back to external `stop && start` until the fork is rebased.

### Restart from Another Agent

```bash
# Soft restart another agent via message bus
cortextos bus send-message assistant high "soft-restart" "goal refresh"

# Check status after restart
cortextos status
```

---

## 3. Changing Agent Model

```bash
AGENT="sentinel"
ORG="myorg"
NEW_MODEL="claude-sonnet-4-6"  # or "claude-opus-4-6" or "claude-haiku-4-5-20251001"

# Step 1: Update config.json
node -e "
const fs = require('fs');
const path = '$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/config.json';
const c = JSON.parse(fs.readFileSync(path));
c.model = '$NEW_MODEL';
fs.writeFileSync(path, JSON.stringify(c, null, 2));
"

# Step 2: Soft restart to pick up new model
cortextos bus send-message "$AGENT" high "soft-restart" "model change to $NEW_MODEL"
```

**Available models:**
- `claude-opus-4-6` - Most capable, highest cost
- `claude-sonnet-4-6` - Good balance, ~5x cheaper than Opus
- `claude-haiku-4-5-20251001` - Fastest, cheapest, for simple tasks

**No model set = default (Opus).** Always set explicitly for cost control.

---

## 4. Managing Bot Tokens

### Creating a New Bot

Guide the user through BotFather:
1. Open Telegram, message @BotFather
2. Send `/newbot`
3. Enter display name (e.g., "Assistant - MyOrg Bot")
4. Enter username (must end in `bot`, e.g., `assistant_myorg_bot`)
5. Copy the token (format: `1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### Getting Chat ID

After the user messages the bot:
```bash
BOT_TOKEN="<the token>"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result[0].message.chat.id)"
```

**Note:** If getUpdates returns empty, the user needs to send /start to the bot first.

### Updating a Bot Token

```bash
AGENT="assistant"
ORG="myorg"

# Edit .env (replace BOT_TOKEN line)
sed -i '' "s/^BOT_TOKEN=.*/BOT_TOKEN=<new_token>/" \
  "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/.env"

# Restart to pick up new token
cortextos bus send-message "$AGENT" high "soft-restart" "bot token updated"
```

---

## 5. Managing .env Files

### Required Fields
```
BOT_TOKEN=<telegram bot token>
CHAT_ID=<telegram chat id for the user>
ALLOWED_USER=<telegram user id for security filtering>
```

### File Permissions
```bash
chmod 600 "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/.env"
```

### Verifying .env
```bash
AGENT_ENV="$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/.env"
if [[ ! -f "$AGENT_ENV" ]]; then
    echo "ERROR: No .env file for $AGENT!"
elif ! grep -q "BOT_TOKEN=" "$AGENT_ENV"; then
    echo "ERROR: Missing BOT_TOKEN in $AGENT .env"
elif ! grep -q "CHAT_ID=" "$AGENT_ENV"; then
    echo "ERROR: Missing CHAT_ID in $AGENT .env"
elif ! grep -q "ALLOWED_USER=" "$AGENT_ENV"; then
    echo "WARNING: Missing ALLOWED_USER - agent will reject all Telegram messages"
fi
```

---

## 6. Managing Crons

### Adding a Cron
```bash
AGENT="sentinel"
ORG="myorg"

node -e "
const fs = require('fs');
const path = '$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/config.json';
const c = JSON.parse(fs.readFileSync(path));
if (!c.crons) c.crons = [];
c.crons.push({ name: 'new-cron', interval: '2h', prompt: 'Do the thing' });
fs.writeFileSync(path, JSON.stringify(c, null, 2));
"

# Notify agent that crons have been updated
cortextos bus send-message "$AGENT" normal \
  'Crons updated in crons.json. The daemon scheduler will pick up the change automatically. To verify: cortextos bus list-crons '"$AGENT"
```

### Removing a Cron
```bash
node -e "
const fs = require('fs');
const path = '$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/config.json';
const c = JSON.parse(fs.readFileSync(path));
c.crons = (c.crons || []).filter(cr => cr.name !== 'cron-to-remove');
fs.writeFileSync(path, JSON.stringify(c, null, 2));
"
cortextos bus send-message "$AGENT" normal 'Cron removed from config.json. Recreate your crons on next restart.'
```

---

## 7. Enabling / Disabling Agents

### Enable
```bash
cortextos enable <agent> --org <org>
```

### Disable
```bash
cortextos disable <agent> --org <org>
```

This stops the agent's PM2 process and marks the agent as disabled. Config and .env are preserved.

---

## 8. Health Checks

### Check All Agents
```bash
cortextos status
cortextos bus read-all-heartbeats
```

### Check Specific Agent Heartbeat
```bash
cat "$HOME/.cortextos/default/state/$AGENT/heartbeat.json"
```

### List All Agents
```bash
cortextos bus list-agents --format json
```

### Check PM2 Process Status
```bash
pm2 list
pm2 jlist | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
d.forEach(p => console.log(p.name, p.pm2_env.status));
"
```

---

## 9. Crash Recovery

### Reset Crash Counter
```bash
rm -f "$HOME/.cortextos/default/state/$AGENT/.crash_count_today"
```

### Force Fresh Start (Lose Conversation)
```bash
echo "" > "$HOME/.cortextos/default/state/$AGENT/.force-fresh"
cortextos enable "$AGENT" --org "$ORG" --restart
```

---

## 10. Troubleshooting

### Agent Not Responding to Telegram
1. Check .env exists and has BOT_TOKEN + CHAT_ID + ALLOWED_USER
2. Check fast-checker is running: `ps aux | grep fast-checker | grep $AGENT`
3. Check fast-checker log: `tail -10 $HOME/.cortextos/default/logs/$AGENT/fast-checker.log`
4. Check agent status: `cortextos status`

### Messages Going to Wrong Person
1. Check .env CHAT_ID - is it the right person's chat ID?
2. Check .env BOT_TOKEN - is it the right bot?
3. If agent was spawned by another agent, the parent's env vars may have leaked (Becky bug)
4. Fix: rewrite .env with correct credentials, soft restart

### Agent Keeps Crashing
1. Check crash count: `cat $HOME/.cortextos/default/state/$AGENT/.crash_count_today`
2. Check stderr: `tail -20 $HOME/.cortextos/default/logs/$AGENT/stderr.log`
3. Common causes: rate limit, auth expired, context exhaustion
4. Fix: reset crash count, fix root cause, `cortextos enable <agent> --restart`

### PM2 Not Restarting Agent
1. Check PM2 status: `pm2 list`
2. Check PM2 logs: `pm2 logs <agent-process-name>`
3. Regenerate ecosystem config: `cortextos ecosystem` then `pm2 restart ecosystem.config.js`
4. If exit code shows throttling, wait 10s then `cortextos enable <agent> --restart`

### New Hook Not Firing After Wiring It Up
1. Confirm `settings.json` is valid JSON and the hook block is in the right shape (matcher, type=command, etc).
2. Try a benign tool call that should trigger the hook. If nothing happens, the hook is not loaded.
3. **Do NOT soft-restart** — `--continue` does not reload project hooks (see Hook Reload Lifecycle in Section 2).
4. Hard-restart the agent: `cortextos bus hard-restart --reason "load new hook"`. The daemon kills the PID and respawns a fresh process that re-reads `settings.json`.
5. If the hook still does not fire after a fresh PID, instrument the script with an unconditional write to `/tmp/<agent>-hook-test.log` at the very top of `main()`, run a benign tool, and check whether the file appears. If yes, the hook is firing but the script is returning early. If no, the hook is wired wrong in `settings.json`.

---

## Quick Reference

| I need to... | Command |
|---|---|
| Create new agent | `cortextos add-agent <name> --template agent --org <org> --runtime claude-code` (or `--template agent-codex --runtime codex-app-server` after asking the user which runtime) |
| Enable agent | `cortextos enable <agent> --org <org>` |
| Disable agent | `cortextos disable <agent> --org <org>` |
| Soft restart (self) | `cortextos bus self-restart --reason "<reason>"` |
| Hard restart (self) | `cortextos bus hard-restart --reason "<reason>"` |
| Restart another agent | `cortextos bus send-message <agent> high "soft-restart" "<reason>"` |
| Change model | Edit config.json model field + soft restart |
| Update bot token | Edit .env BOT_TOKEN + soft restart |
| Add cron | Edit config.json crons + notify agent |
| Check health | `cortextos status` or `cortextos bus read-all-heartbeats` |
| List agents | `cortextos bus list-agents --format json` |
| Check PM2 | `pm2 list` |
| Reset crash count | `rm ~/.cortextos/default/state/<agent>/.crash_count_today` |
| Force fresh start | Write .force-fresh + `cortextos enable --restart` |
