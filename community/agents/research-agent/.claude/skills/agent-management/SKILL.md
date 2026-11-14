---
name: agent-management
description: "You need to create a new agent, restart a crashed agent, change an agent's model or config, fix a Telegram bot token, troubleshoot why an agent is not responding, enable or disable an agent, spawn an agent for another user, manage PM2 process management, reset crash limits, or do anything that touches an agent's lifecycle, configuration, or credentials. This is the definitive guide for every agent operation in cortextOS."
triggers: ["new agent", "create agent", "spawn agent", "add agent", "restart", "soft restart", "hard restart", "disable agent", "enable agent", "change model", "switch model", "bot token", "BotFather", "agent not responding", "agent crashed", "agent down", "crash limit", "reset crashes", "agent health", "list agents", "heartbeat", "onboard", "setup agent", "configure agent", ".env", "config.json", "pm2", "ecosystem.config", "cross-org", "agent for someone else", "agent management", "agent lifecycle", "agent credentials", "telegram bot", "token not working"]
---

# Agent Management

> The definitive guide for managing cortextOS agent lifecycle. Every operation, every script, every protocol. Follow these EXACTLY - do not improvise.

---

## CRITICAL RULES

1. **ALWAYS use the CLI for daemon-owned state.** Never manually edit the daemon's state files (under `~/.cortextos/<instance>/state/`) without using the proper command. This rule does not cover agent config files such as `.env` and `config.json`, which this skill edits by hand where shown. Documented exceptions for state files: writing a `.force-fresh` marker into an agent's state directory (Section 2 Hook Reload Lifecycle, Section 9 Force Fresh Start) and deleting `.crash_count_today` (Section 9 Reset Crash Counter, Quick Reference).
2. **ALWAYS create .env before enabling.** An agent without .env may inherit parent credentials.
3. **ALWAYS write restart markers before /exit.** Use `cortextos bus self-restart`, never raw /exit.
4. **ALWAYS use `cortextos enable` to start agents.** It checks the agent's .env, registers the agent and starts it through the daemon. Documented exceptions: `cortextos start` with no agent starts the daemon itself (run it from the framework root, with `--instance <instance>` if not default), and the stale-fork fallback at the end of Section 2's Hook Reload Lifecycle uses `cortextos stop <agent> && cortextos start <agent>`. Never manually edit PM2 config.
5. **NEVER share bot tokens between agents.** Each agent gets its own bot from @BotFather.
6. **NEVER hardcode chat IDs.** Get them from the actual user via Telegram getUpdates.
7. **ALWAYS ask the user which runtime** (claude-code, codex-app-server, or opencode) before scaffolding a new agent. Default to claude-code only if the user has no preference. Never silently pick.

---

## 1. Creating a New Agent

### For Yourself (Same User)

```bash
# Option A: CLI (recommended)

# STEP 0 — REQUIRED BEFORE SCAFFOLDING — Ask the user which runtime:
#   "Should this agent run on Claude Code (Anthropic), Codex (OpenAI, model from Codex's own config),
#    or OpenCode (provider-agnostic TUI, default model openai/gpt-4.1-nano from the agent-opencode template)?"
# Default to claude-code if the user has no preference. Never silently pick.
# Codex agents MUST use the agent-codex template; OpenCode agents MUST use the
# agent-opencode template. Passing --template agent auto-maps to the runtime's
# native bootstrap (agent-codex for codex, agent-opencode for opencode).
# orchestrator/analyst/m2c1-worker have no codex/opencode variant: codex is
# rejected outright with those templates; opencode is not blocked but would
# scaffold a Claude-oriented bootstrap under an opencode runtime, so avoid it.

# claude-code path (the common one):
cortextos add-agent <name> --template agent --org <org> --runtime claude-code

# codex-app-server path (codex CLI app-server JSONRPC; the model comes from Codex's own config,
# and config.json model is only a cost label, see section 3):
cortextos add-agent <name> --template agent-codex --org <org> --runtime codex-app-server

# opencode path (provider-agnostic OpenCode TUI; ships the context-handoff
# lifecycle, default-on at 60% of the context window; model set in config.json,
# default openai/gpt-4.1-nano from the agent-opencode template's config.json).
# --template agent auto-maps to agent-opencode:
cortextos add-agent <name> --template agent-opencode --org <org> --runtime opencode

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

**Common Mistake:** If you skip the .env creation, the agent can inherit credentials from the parent environment. Messages meant for the new agent may route through the wrong identity. ALWAYS create .env BEFORE enabling.

---

## 2. Restarting Agents

### Soft Restart (Preserves Conversation)

```bash
# Via bus command (preferred — writes marker file automatically)
cortextos bus self-restart --reason "<reason>"

# Restart a DIFFERENT agent
AGENT_NAME="myagent"   # the agent to restart
cortextos bus soft-restart "$AGENT_NAME" "<reason>"
```

**What it does:**
1. Writes `.user-restart` marker (prevents false crash alert)
2. Sends an IPC `restart-agent` request to the daemon
3. Daemon stops the agent gracefully (`/exit` on Claude Code) and starts it again, re-reading `config.json` and `.env`
4. Relaunches with --continue when a previous session exists (preserves conversation history). A `.force-fresh` marker already on disk (the context-handoff prompt pre-writes one) makes it a fresh session instead

### Hard Restart (Fresh Session, Loses History)

```bash
cortextos bus hard-restart --reason "context exhaustion"
```

**When to use:** Context window full, conversation corrupted, need clean slate, or wiring a new hook (see Hook Reload Lifecycle below). Hard-restart sends an IPC `restart-agent` signal to the daemon, which stops the agent and starts it again. The respawn consumes the `.force-fresh` marker and skips `--continue`, so the next session is fresh.

### Hook Reload Lifecycle

Soft restart (`cortextos bus self-restart`) stops the agent and starts a new Claude process with `--continue` when a previous session exists and no `.force-fresh` marker is present (otherwise the new session is fresh). Whether a continued session picks up `.claude/settings.json` hooks (PreToolUse, PostToolUse, Stop, SessionStart, etc) added or changed since the original boot has not been verified. After changing hooks, use a hard restart (fresh session, no `--continue`) to be sure. `cortextos bus hard-restart --reason "<why>"` writes `.force-fresh` and restarts only the calling agent: the one named by `CTX_AGENT_NAME`, which the daemon sets in every agent session. If you changed ANOTHER agent's hooks, arm that agent's `.force-fresh` marker and restart it from outside, as below.

**When wiring a new hook to a running agent, use a hard restart, not a soft restart:**

From inside the agent whose hooks changed (restarts only the calling agent):

```bash
cortextos bus hard-restart --reason "loading new hook"
```

From outside, for another agent (arm its fresh-boot marker, then restart it):

```bash
AGENT="myagent"
ORG="myorg"
INSTANCE="default"  # the agent's cortextOS instance; `cortextos restart` ignores CTX_INSTANCE_ID
mkdir -p "$HOME/.cortextos/$INSTANCE/state/$AGENT"
echo "loading new hook" > "$HOME/.cortextos/$INSTANCE/state/$AGENT/.force-fresh"
if RESTART_OUT=$(cortextos restart "$AGENT" --instance "$INSTANCE" 2>&1); then
  echo "$RESTART_OUT"
else
  echo "Restart failed: $RESTART_OUT"
  echo "If INSTANCE ($INSTANCE) is the agent's instance, .force-fresh stays armed and its next start boots fresh: cortextos enable $AGENT --org $ORG --instance $INSTANCE (if the daemon is down, run cortextos start --instance $INSTANCE from the framework root first)."
  echo "If INSTANCE was wrong, remove the stray marker: rm -f $HOME/.cortextos/$INSTANCE/state/$AGENT/.force-fresh"
fi
```

Both start the next session fresh, without `--continue`: the daemon checks for `.force-fresh` when it starts the agent and deletes it only after a successful fresh spawn. The outside path is read from source, not tested end to end. Verify by adding a one-line debug write to your hook script before testing — if the file shows up after a benign tool call, the hook is loaded.

If `bus hard-restart` writes restart markers without actually stopping the process, the running fork may be stale. Fall back to arming that agent's `.force-fresh` (path above), then `cortextos stop <agent> && cortextos start <agent>`, until the fork is updated; those forks predate `cortextos restart`. Without the marker, `stop && start` comes back with `--continue`.

### Restart from Another Agent

```bash
# Soft restart another agent via the daemon
cortextos bus soft-restart assistant "goal refresh"

# Check status after restart
cortextos status
```

---

## 3. Changing Agent Model

Whether `config.json` `model` takes effect depends on the runtime:
- `claude-code` and `opencode`: passed as `--model` when the daemon starts the agent process.
- `codex-app-server`: never sent to Codex. The model comes from Codex's own config: by default `model` in `~/.codex/config.toml`; a `CODEX_HOME` set in the org `secrets.env` or the agent's `.env` would change that (not verified here). Restart the agent after editing it. `config.json` `model` only labels the cost log (`codex-tokens.jsonl`) that the dashboard prices from, so keep it equal to the real model or cost data is mislabeled.
- `hermes`: never passed. The model comes from Hermes's own configuration.

On `codex-app-server` and `hermes`, changing `config.json` `model` does not change the model the runtime uses, and the Model column of `cortextos status` shows the value the daemon loaded from `config.json`, not necessarily the model in effect.

When `config.json` is re-read: every restart through the daemon's start path re-reads it (`cortextos restart`, `cortextos stop` + `start` (re-reads config, but use `cortextos restart` except as Rule 4 notes), `cortextos bus soft-restart` / `self-restart` / `hard-restart`, a dashboard restart, a daemon restart, and a normal context handoff, where the agent runs `bus hard-restart`). Relaunches inside a running agent reuse the copy already in memory: crash recovery, the session-time refresh, and the forced context handoff when the agent ignores the handoff prompt. Messaging an agent "soft-restart" does not restart it. After editing the model, restart through the CLI and verify on the process; the Model column only shows the value the daemon loaded from `config.json`.

```bash
AGENT="sentinel"
ORG="myorg"
INSTANCE="default"  # the agent's cortextOS instance; `cortextos restart` and `start` ignore CTX_INSTANCE_ID
NEW_MODEL="claude-sonnet-4-6"  # or "claude-opus-4-6" or "claude-haiku-4-5-20251001"

# Step 1: Update config.json
node -e "
const fs = require('fs');
const path = '$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/config.json';
const c = JSON.parse(fs.readFileSync(path));
c.model = '$NEW_MODEL';
fs.writeFileSync(path, JSON.stringify(c, null, 2));
"
RUNTIME=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.runtime === "string" ? c.runtime : "")' "$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/config.json")  # empty = claude-code

# Step 2: Restart through the CLI (claude-code and opencode)
# Re-reads config.json and .env, respawns, keeps conversation history.
# An agent changing its OWN model skips Steps 2-3 and uses the self-check below.
# agent_pid: PID from the status row whose Name is exactly $AGENT (names of 18+ chars run into the Status column)
agent_pid() { cortextos status --instance "$INSTANCE" | awk -v a="$AGENT" '{ r = substr($0, 3 + length(a)) } substr($0, 3, length(a)) == a && (length(a) < 18 ? r ~ /^ / : r ~ /^(running|stopped|crashed|starting|halted|unhealthy\*|dormant†) /) { split(r, f, " "); print f[2] }'; }
OLD_PID=$(agent_pid)
RESTART_OK=yes
if RESTART_OUT=$(cortextos restart "$AGENT" --instance "$INSTANCE" 2>&1); then
  echo "$RESTART_OUT"
else
  RESTART_OK=""
  echo "Restart failed: $RESTART_OUT"
  echo "If INSTANCE ($INSTANCE) is right and the daemon is up, $AGENT is not running: cortextos enable $AGENT --org $ORG --instance $INSTANCE (if the daemon is down, run cortextos start --instance $INSTANCE from the framework root first)."
  echo "Once it is running, verify with the standalone check below (set CTX_AGENT_NAME=$AGENT CTX_INSTANCE_ID=$INSTANCE CTX_AGENT_DIR=$CTX_FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT first). Do not re-run Step 2."
fi

# Step 3: Verify on the process, once
# restart returns before the stop finishes (a Claude Code stop can take ~26s) and the PID shows "-"
# meanwhile, so wait up to 90s for a new numeric PID. Do not run Step 2 again if this fails.
PID=""
for i in $(seq 1 30); do
  [ -n "$RESTART_OK" ] || break
  sleep 3
  P=$(agent_pid)
  case "$P" in ''|*[!0-9]*) ;; *) if [ "$P" != "$OLD_PID" ]; then PID=$P; break; fi ;; esac
done
GOT=""
ALIVE=""
if [ -n "$PID" ] && ARGS=$(ps -o args= -p "$PID"); then
  ALIVE=yes
  GOT=$(printf '%s\n' "$ARGS" | awk '{ for (i = 1; i <= NF && substr($i, 1, 2) != "--"; i++); if (i > 3 && i <= NF) { print "cannot read"; next } while ($i == "--continue" || $i == "--dangerously-skip-permissions") i++; if ($i == "--model") print $(i + 1) }')
fi
LOG="$HOME/.cortextos/$INSTANCE/logs/$AGENT/stdout.log"
if [ -z "$RESTART_OK" ]; then
  true
elif [ "$RUNTIME" = "codex-app-server" ] || [ "$RUNTIME" = "hermes" ]; then
  echo "Restarted. The --model check is not applicable: $RUNTIME does not take --model from config.json (see the runtime list above)"
elif [ -z "$PID" ]; then
  echo "No new PID after 90s (a config.json startup_delay, in seconds, delays the spawn further). Do not restart again; check cortextos status --instance $INSTANCE and $LOG"
elif [ -z "$ALIVE" ]; then
  echo "PID $PID exited before the check. Do not restart again; check cortextos status --instance $INSTANCE and $LOG"
elif [ "$GOT" = "cannot read" ]; then
  echo "UNREADABLE: PID $PID has three or more words before its first word starting with --, so this check cannot read its --model. Do not restart again; check ps -o args= -p $PID by hand"
elif [ "$GOT" = "$NEW_MODEL" ]; then
  echo "OK: PID $PID runs --model ${GOT:-(none)}"
else
  echo "MISMATCH: PID $PID runs --model ${GOT:-(none)}, expected ${NEW_MODEL:-(none)}. Do not restart again; check config.json and $LOG"
fi
```

Both checks read `--model` only where the daemon puts it: the first flag, which must start within the first three words (after `claude`, `node cli.js`, or a binary path with one space), after `--continue` and `--dangerously-skip-permissions`. A process with no word starting with "--" reports `(none)`, however many words it has (for example `claude You are starting a new session`).

If the first word starting with "--" comes after the third word, the check cannot tell the binary from the prompt and prints `UNREADABLE` instead of OK or MISMATCH; check `ps -o args= -p <pid>` by hand. An agent process the daemon started hits this in two ways. One is a binary prefix of three or more words (a path with two spaces, or `node` plus a path with one space) when the process also has a flag; with that prefix and no word starting with "--", it still reports `(none)`. The other is a process with no flags whose prompt contains a word starting with "--" (its prompt starts with two words, so that word always comes after the third).

The daemon puts every flag of an agent process before the prompt, its prompt starts with "You are" or "SESSION CONTINUATION:", and OpenCode and Hermes agents get no prompt on the command line, so for an agent process the daemon started the check never takes a "--model" inside the prompt for the model. These checks only look up agents in `cortextos status`, never workers. A worker the daemon started passes its task text as the prompt, so a task that starts with "--model" can be read as the model, as can such a prompt in a process the daemon did not start. A wrapper that adds its own flag first (for example `claude --verbose --model <model> <prompt>`) is not a shape the daemon starts either: the check can then print OK or MISMATCH on the wrong value, so for a wrapped process check `ps -o args= -p <pid>` by hand and do not trust what the check printed.

An agent changing its OWN model runs Step 1, then `cortextos bus self-restart --reason "model change"` instead of Steps 2-3 (the stop types into its own session). From its next session it checks its own process against its `config.json`. The same standalone check works from outside for any running agent: set `CTX_AGENT_NAME`, `CTX_INSTANCE_ID` and `CTX_AGENT_DIR` to its name, instance and directory first.

```bash
# The daemon sets CTX_AGENT_NAME, CTX_INSTANCE_ID and CTX_AGENT_DIR in every agent session. From outside, set them
# to the agent's name, instance and directory ($CTX_FRAMEWORK_ROOT/orgs/<org>/agents/<agent>) first.
# The expected model is read from that agent's config.json; an empty or absent model means "expect no --model".
if [ -z "$CTX_AGENT_NAME" ] || [ -z "$CTX_INSTANCE_ID" ] || [ -z "$CTX_AGENT_DIR" ]; then
  echo "CTX_AGENT_NAME, CTX_INSTANCE_ID and CTX_AGENT_DIR must be set (the daemon sets them in an agent session; set them by hand from outside)"
elif ! RUNTIME=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.runtime === "string" ? c.runtime : "")' "$CTX_AGENT_DIR/config.json"); then
  echo "Cannot read $CTX_AGENT_DIR/config.json"
elif [ "$RUNTIME" = "codex-app-server" ] || [ "$RUNTIME" = "hermes" ]; then
  echo "Not applicable: $RUNTIME does not take --model from config.json (see the runtime list at the top of this section)"
elif ! NEW_MODEL=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.model === "string" ? c.model : "")' "$CTX_AGENT_DIR/config.json"); then
  echo "Cannot read the model from $CTX_AGENT_DIR/config.json"
else
  PID=$(cortextos status --instance "$CTX_INSTANCE_ID" | awk -v a="$CTX_AGENT_NAME" '{ r = substr($0, 3 + length(a)) } substr($0, 3, length(a)) == a && (length(a) < 18 ? r ~ /^ / : r ~ /^(running|stopped|crashed|starting|halted|unhealthy\*|dormant†) /) { split(r, f, " "); print f[2] }')
  case "$PID" in
    ''|*[!0-9]*) echo "No running PID for $CTX_AGENT_NAME in cortextos status --instance $CTX_INSTANCE_ID" ;;
    *) if ! ARGS=$(ps -o args= -p "$PID"); then
         echo "PID $PID exited before the check; check cortextos status --instance $CTX_INSTANCE_ID"
       else
         GOT=$(printf '%s\n' "$ARGS" | awk '{ for (i = 1; i <= NF && substr($i, 1, 2) != "--"; i++); if (i > 3 && i <= NF) { print "cannot read"; next } while ($i == "--continue" || $i == "--dangerously-skip-permissions") i++; if ($i == "--model") print $(i + 1) }')
         if [ "$GOT" = "cannot read" ]; then
           echo "UNREADABLE: PID $PID has three or more words before its first word starting with --, so this check cannot read its --model. Do not restart again; check ps -o args= -p $PID by hand"
         elif [ "$GOT" = "$NEW_MODEL" ]; then
           echo "OK: PID $PID runs --model ${GOT:-(none)}, matching config.json"
         else
           echo "MISMATCH: PID $PID runs --model ${GOT:-(none)}, config.json says ${NEW_MODEL:-(none)}. Do not restart again; check config.json and $HOME/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stdout.log"
         fi
       fi ;;
  esac
fi
```

**Available models:**
- `claude-opus-4-6` - Most capable, highest cost
- `claude-sonnet-4-6` - Good balance, ~5x cheaper than Opus
- `claude-haiku-4-5-20251001` - Fastest, cheapest, for simple tasks

**Context window suffix:** Append `[1m]` to any model ID (e.g., `claude-opus-4-6[1m]`) to enable the extended 1M token context window. Without it, agents get the default shorter context window and will compact much sooner. Recommended for orchestrators and any agent doing complex multi-step work.

**No model set = no `--model` flag.** The runtime's own default applies; cortextOS passes no default to the runtime (on `codex-app-server`, an unset model only makes the cost log label read `gpt-5-codex`). (The agent-opencode template's `config.json` does set `openai/gpt-4.1-nano`, so new opencode agents start with a model set.) Always set explicitly for cost control.

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

# Restart to pick up new token (re-reads .env)
cortextos bus soft-restart "$AGENT" "bot token updated"
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

Crons are daemon-managed and persisted to `${CTX_ROOT}/state/<agent>/crons.json`. The daemon dispatches them automatically — no agent-side restoration needed. Use the bus commands; do NOT edit `config.json` or use `/loop` / `CronCreate`.

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
cortextos disable <agent>   # add --instance <id> if not on the default instance; disable takes no --org
```

This marks the agent disabled in the instance's enabled-agents list and, if the daemon is running, stops it through the daemon. Config and .env are preserved.

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
AGENT="myagent"
ORG="myorg"
INSTANCE="default"  # the agent's cortextOS instance; `cortextos restart` ignores CTX_INSTANCE_ID
mkdir -p "$HOME/.cortextos/$INSTANCE/state/$AGENT"
echo "force fresh start" > "$HOME/.cortextos/$INSTANCE/state/$AGENT/.force-fresh"
if RESTART_OUT=$(cortextos restart "$AGENT" --instance "$INSTANCE" 2>&1); then
  echo "$RESTART_OUT"
else
  echo "Restart failed: $RESTART_OUT"
  echo "If INSTANCE ($INSTANCE) is the agent's instance, .force-fresh stays armed and its next start boots fresh: cortextos enable $AGENT --org $ORG --instance $INSTANCE (if the daemon is down, run cortextos start --instance $INSTANCE from the framework root first)."
  echo "If INSTANCE was wrong, remove the stray marker: rm -f $HOME/.cortextos/$INSTANCE/state/$AGENT/.force-fresh"
fi
```

---

## 10. Troubleshooting

### Agent Not Responding to Telegram
1. Check .env exists and has BOT_TOKEN + CHAT_ID + ALLOWED_USER
2. Check fast-checker is running: `ps aux | grep fast-checker | grep $AGENT`
3. Check agent output: `tail -50 $HOME/.cortextos/default/logs/$AGENT/stdout.log` and `tail -20 $HOME/.cortextos/default/logs/$AGENT/crashes.log`
4. Check agent status: `cortextos status`

### Messages Going to Wrong Person
1. Check .env CHAT_ID - is it the right person's chat ID?
2. Check .env BOT_TOKEN - is it the right bot?
3. If agent was spawned by another agent, the parent's env vars may have leaked
4. Fix: rewrite .env with correct credentials, soft restart

### Agent Keeps Crashing
1. Check crash count: `cat $HOME/.cortextos/default/state/$AGENT/.crash_count_today`
2. Check crashes/restarts: `tail -20 $HOME/.cortextos/default/logs/$AGENT/crashes.log` and `tail -20 $HOME/.cortextos/default/logs/$AGENT/stdout.log`
3. Common causes: rate limit, auth expired, context exhaustion
4. Fix: reset crash count, fix root cause, then `cortextos restart <agent>` (or `cortextos enable <agent> --org <org> --instance <instance>` if it is not running; if the daemon is down, run `cortextos start --instance <instance>` from the framework root first)

### PM2 Not Restarting Agent
1. Check PM2 status: `pm2 list`
2. Check PM2 logs: `pm2 logs <agent-process-name>`
3. Regenerate ecosystem config: `cortextos ecosystem` then `pm2 restart ecosystem.config.js`
4. If exit code shows throttling, wait 10s then `cortextos restart <agent>` (or `cortextos enable <agent> --org <org> --instance <instance>` if it is not running; if the daemon is down, run `cortextos start --instance <instance>` from the framework root first)

### New Hook Not Firing After Wiring It Up
1. Confirm `settings.json` is valid JSON and the hook block is in the right shape (matcher, type=command, etc).
2. Try a benign tool call that should trigger the hook. If nothing happens, the hook is not loaded.
3. **Do not rely on a soft restart** — whether a `--continue` session picks up changed hooks has not been verified (see Hook Reload Lifecycle in Section 2).
4. Hard-restart the agent: from inside it, `cortextos bus hard-restart --reason "load new hook"`; for another agent, use the outside block in Hook Reload Lifecycle. The next session starts fresh, without `--continue`.
5. If the hook still does not fire after a fresh PID, instrument the script with an unconditional write to `/tmp/<agent>-hook-test.log` at the very top of `main()`, run a benign tool, and check whether the file appears. If yes, the hook is firing but the script is returning early. If no, the hook is wired wrong in `settings.json`.

---

## Quick Reference

| I need to... | Command |
|---|---|
| Create new agent | `cortextos add-agent <name> --template agent --org <org> --runtime claude-code` (or `--template agent-codex --runtime codex-app-server`, or `--template agent-opencode --runtime opencode`, after asking the user which runtime) |
| Enable agent | `cortextos enable <agent> --org <org>` |
| Disable agent | `cortextos disable <agent>` (plus `--instance <id>` if not default) |
| Soft restart (self) | `cortextos bus self-restart --reason "<reason>"` |
| Hard restart (self) | `cortextos bus hard-restart --reason "<reason>"` |
| Restart another agent | `cortextos bus soft-restart <agent> "<reason>"` |
| Change model | claude-code/opencode: edit config.json model field, then `cortextos restart <agent>`; verify `--model` on the new PID (section 3). An agent changing its own model edits config.json and runs `cortextos bus self-restart` instead (section 3). codex-app-server: `model` in Codex's own config (default `~/.codex/config.toml`), then restart the agent. hermes: Hermes's own config |
| Update bot token | Edit .env BOT_TOKEN + soft restart |
| Add cron | `cortextos bus add-cron <agent> <name> <interval> "<prompt>"` |
| Check health | `cortextos status` or `cortextos bus read-all-heartbeats` |
| List agents | `cortextos bus list-agents --format json` |
| Check PM2 | `pm2 list` |
| Reset crash count | `rm ~/.cortextos/default/state/<agent>/.crash_count_today` |
| Force fresh start | Write `~/.cortextos/<instance>/state/<agent>/.force-fresh`, then `cortextos restart <agent> --instance <instance>` (section 9) |
