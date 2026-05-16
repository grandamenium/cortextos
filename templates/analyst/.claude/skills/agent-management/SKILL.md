---
name: agent-management
description: "You need to create a new agent, restart a crashed agent, change an agent's model or config, fix a Telegram bot token, troubleshoot why an agent is not responding, enable or disable an agent, spawn an agent for another user, manage PM2 process management, reset crash limits, or do anything that touches an agent's lifecycle, configuration, or credentials. This is the definitive guide for every agent operation in cortextOS."
triggers: ["new agent", "create agent", "spawn agent", "add agent", "restart", "soft restart", "hard restart", "disable agent", "enable agent", "change model", "switch model", "bot token", "BotFather", "agent not responding", "agent crashed", "agent down", "crash limit", "reset crashes", "agent health", "list agents", "heartbeat", "onboard", "setup agent", "configure agent", ".env", "config.json", "pm2", "ecosystem.config", "cross-org", "agent for someone else", "agent management", "agent lifecycle", "agent credentials", "telegram bot", "token not working"]
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

---

## 1. Creating a New Agent

### For Yourself (Same User)

```bash
# Option A: CLI (recommended)
cortextos add-agent <name> --template agent --org <org>

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

# Step 6.5: PRE-ENABLE CHECKLIST — DO NOT SKIP
# Lesson from 2026-05-11: an agent enabled with template placeholders + generic
# Autonomy Rules came online and asked Hari what it should be doing. Hari
# expects agents to describe what they are starting on, not ask. Running these
# spot-checks before `cortextos enable` prevents this class of failure.

AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME"

# Check 1: No unfilled template placeholders.
if grep -rn "{{" "$AGENT_DIR"/IDENTITY.md "$AGENT_DIR"/SOUL.md "$AGENT_DIR"/GUARDRAILS.md "$AGENT_DIR"/USER.md "$AGENT_DIR"/GOALS.md 2>/dev/null; then
  echo "❌ FAIL: unfilled {{placeholders}} found — fill them before enable"
  exit 1
fi

# Check 2: SOUL.md Day/Night Mode is concrete.
grep -q "Day Mode ([0-9]" "$AGENT_DIR/SOUL.md" || { echo "❌ FAIL: SOUL.md Day Mode hours not set"; exit 1; }

# Check 3: SOUL.md Autonomy Rules is agent-specific (not generic stock).
SOUL_AUTONOMY_LINES=$(awk '/^## Autonomy Rules/{found=1; next} found && /^## /{exit} found' "$AGENT_DIR/SOUL.md" | wc -l)
[ "$SOUL_AUTONOMY_LINES" -ge 10 ] || { echo "❌ FAIL: SOUL.md Autonomy Rules looks generic ($SOUL_AUTONOMY_LINES lines). Author specifics."; exit 1; }

# Check 4: GUARDRAILS.md has agent-specific red flags.
GUARDRAIL_ROWS=$(grep -c "^| " "$AGENT_DIR/GUARDRAILS.md" 2>/dev/null || echo 0)
[ "$GUARDRAIL_ROWS" -ge 10 ] || echo "⚠ WARN: GUARDRAILS.md has only $GUARDRAIL_ROWS rows — consider adding agent-specific patterns"

# Check 5: goals.json has concrete boot actions.
GOALS_COUNT=$(jq '.goals | length' "$AGENT_DIR/goals.json" 2>/dev/null || echo 0)
[ "$GOALS_COUNT" -ge 3 ] || { echo "❌ FAIL: goals.json has only $GOALS_COUNT goals"; exit 1; }
grep -qiE "on boot|priority [0-9]|start with|begin with|first action" "$AGENT_DIR/goals.json" || echo "⚠ WARN: no explicit ON BOOT action in goals.json"

# Check 6: USER.md Communication Style describes the agent's channels.
# Telegram-enabled signal is config.json's telegram_polling field (NOT just
# BOT_TOKEN presence — template scaffold ships with empty BOT_TOKEN= even for
# no-Telegram agents).
TELEGRAM_POLLING=$(jq -r '.telegram_polling // false' "$AGENT_DIR/config.json" 2>/dev/null || echo "false")
if [ "$TELEGRAM_POLLING" = "true" ]; then
  grep -q -i "Telegram" "$AGENT_DIR/USER.md" || { echo "❌ FAIL: telegram_polling=true but USER.md does not describe Telegram register"; exit 1; }
fi

# Check 7: If telegram_polling=true, .env must have BOT_TOKEN AND CHAT_ID
# populated. If telegram_polling=false (or missing), empty BOT_TOKEN/CHAT_ID
# in .env is fine — common for no-Telegram specialist agents.
if [ "$TELEGRAM_POLLING" = "true" ]; then
  if ! grep -qE "^BOT_TOKEN=.+" "$AGENT_DIR/.env" 2>/dev/null; then
    echo "❌ FAIL: telegram_polling=true but BOT_TOKEN is empty/missing in .env"
    exit 1
  fi
  if ! grep -qE "^CHAT_ID=.+" "$AGENT_DIR/.env" 2>/dev/null; then
    echo "❌ FAIL: telegram_polling=true but CHAT_ID is empty/missing in .env — Telegram will fail to validate"
    exit 1
  fi
fi

# Check 8: config.json agent_name correct.
[ "$(jq -r '.agent_name' "$AGENT_DIR/config.json")" = "$AGENT_NAME" ] || { echo "❌ FAIL: config.json agent_name mismatch"; exit 1; }

# Check 9: IDENTITY.md is substantively authored.
[ "$(grep -cv '^$' "$AGENT_DIR/IDENTITY.md")" -ge 20 ] || { echo "❌ FAIL: IDENTITY.md too thin"; exit 1; }

echo "✅ Pre-enable checklist passed for $AGENT_NAME"

# Step 7: Enable agent (registers with daemon)
cortextos enable "$AGENT_NAME" --org "$ORG"

# Step 8: Verify
cortextos status

# Step 9: Watch first heartbeat. If the agent comes online and asks "what should
# I do?", that's a config bug — stop the agent, audit identity files, fix, re-enable.
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

**When to use:** Context window full, conversation corrupted, need clean slate.

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

**Context window suffix:** Append `[1m]` to any model ID (e.g., `claude-opus-4-6[1m]`) to enable the extended 1M token context window. Without it, agents get the default shorter context window and will compact much sooner. Recommended for orchestrators and any agent doing complex multi-step work.

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

Crons are daemon-managed and persisted to `${CTX_ROOT}/.cortextOS/state/agents/<agent>/crons.json`. The daemon dispatches them automatically — no agent-side restoration needed. Use the bus commands; do NOT edit `config.json` or use `/loop` / `CronCreate`.

### Adding a Cron
```bash
cortextos bus add-cron <agent> <name> <interval-or-cron-expr> "<prompt>"
# Example: cortextos bus add-cron sentinel new-cron 2h "Do the thing"
```

### Removing a Cron
```bash
cortextos bus remove-cron <agent> <name>
```

### Updating a Cron
```bash
cortextos bus update-cron <agent> <name> --interval <new>
```

### Listing Crons
```bash
cortextos bus list-crons <agent>
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
cortextos list-agents --format json
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

---

## Quick Reference

| I need to... | Command |
|---|---|
| Create new agent | `cortextos add-agent <name> --template <type> --org <org>` |
| Enable agent | `cortextos enable <agent> --org <org>` |
| Disable agent | `cortextos disable <agent> --org <org>` |
| Soft restart (self) | `cortextos bus self-restart --reason "<reason>"` |
| Hard restart (self) | `cortextos bus hard-restart --reason "<reason>"` |
| Restart another agent | `cortextos bus send-message <agent> high "soft-restart" "<reason>"` |
| Change model | Edit config.json model field + soft restart |
| Update bot token | Edit .env BOT_TOKEN + soft restart |
| Add cron | `cortextos bus add-cron <agent> <name> <interval> "<prompt>"` |
| Check health | `cortextos status` or `cortextos bus read-all-heartbeats` |
| List agents | `cortextos list-agents --format json` |
| Check PM2 | `pm2 list` |
| Reset crash count | `rm ~/.cortextos/default/state/<agent>/.crash_count_today` |
| Force fresh start | Write .force-fresh + `cortextos enable --restart` |
