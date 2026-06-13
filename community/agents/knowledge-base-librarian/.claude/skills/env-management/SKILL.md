---
name: env-management
description: "You need to add a new API key to the system, update an existing credential, check what secrets are configured for the org or a specific agent, onboard a new third-party tool that needs credentials, diagnose why an agent cannot access a service because a key appears missing, rotate a compromised or expired key, or restart affected agents after a credential change. This skill covers the full lifecycle of environment variables and secrets in cortextOS."
triggers: ["add key", "api key", "env file", ".env", "secret", "credential", "token", "environment variable", "configure key", "set key", "missing key", "key not set", "where do I put", "shared secret", "org secret", "agent secret", "key not loading", "configure credentials", "new api key", "add to env", "rotate key", "rotate token", "key compromised", "token expired", "update api key", "new bot token", "revoke key", "credential rotation", "key rotation", "secret rotation", "key was leaked", "compromised credential", "force rotation", "provider rotated", "expired key", "rotate credentials", "update secret"]
---

# Environment Variable Management

cortextOS uses a 4-layer env hierarchy. Later layers override earlier ones:

```
1. Base shell (PATH, HOME, etc.)
2. CTX_* vars (set by agent-pty at session start)
3. orgs/{org}/secrets.env  ← shared secrets, all agents in the org
4. orgs/{org}/agents/{agent}/.env  ← agent-specific secrets
```

---

## Where Each Key Lives

| Key type | File | Example |
|----------|------|---------|
| Shared API keys (multiple agents use) | `orgs/{org}/secrets.env` | `OPENAI_API_KEY`, `APIFY_TOKEN`, `GEMINI_API_KEY` |
| Agent Telegram credentials | `agents/{agent}/.env` | `BOT_TOKEN`, `CHAT_ID`, `ALLOWED_USER` |
| Agent OAuth tokens | `agents/{agent}/.env` | `CLAUDE_CODE_OAUTH_TOKEN` |

**Rule:** If more than one agent uses a key, it belongs in `orgs/{org}/secrets.env`. If only one agent uses it, it belongs in that agent's `.env`.

`ANTHROPIC_API_KEY` is inherited from the shell that launched the daemon — never stored in any file.

---

## Adding a New Shared Secret

```bash
# 1. Locate the org .env
ORG_ENV="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/secrets.env"

# 2. Append the new key (never overwrite existing)
echo 'NEW_KEY=value' >> "$ORG_ENV"
chmod 600 "$ORG_ENV"

# 3. Restart all running agents so they pick it up
cortextos bus list-agents --format json | jq -r '.[].name' | while read agent; do
  echo "Restarting $agent..."
  cortextos bus send-message "$agent" high "hard-restart" "new shared secret added: NEW_KEY"
  sleep 10
done
```

---

## Adding an Agent-Specific Secret

```bash
# 1. Locate the agent .env
AGENT_ENV="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/.env"

# 2. Append the key
echo 'MY_KEY=value' >> "$AGENT_ENV"
chmod 600 "$AGENT_ENV"

# 3. Restart THIS agent only
cortextos bus self-restart --reason "new agent secret added: MY_KEY"
```

---

## Checking What Keys Are Configured

```bash
# Check org-level keys (names only — never print values)
grep -v '^#' "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/.env" | grep '=' | cut -d= -f1

# Check agent-level keys (names only)
grep -v '^#' "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/.env" | grep '=' | cut -d= -f1

# Verify a key is set in current session
[[ -n "${SOME_KEY:-}" ]] && echo "SET" || echo "NOT SET"
```

---

## Rotating a Secret

A key update without restarting the agent does nothing — the old value stays in the PTY environment until the process restarts.

### Rotation Decision Tree

```
Is this a shared org-level key (OPENAI_API_KEY, APIFY_TOKEN, etc.)?
  → Update orgs/{org}/secrets.env → hard-restart ALL agents

Is this an agent-specific key (BOT_TOKEN, CHAT_ID, OAuth token)?
  → Update agents/{agent}/.env → hard-restart THAT AGENT ONLY

Is this ANTHROPIC_API_KEY?
  → Update ~/.zshrc or ~/.bashrc → restart the daemon via PM2
  → Do NOT store in any .env file
```

### Rotating a Shared Org Secret

```bash
ORG_ENV="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/secrets.env"
# Update the value in the file (edit KEY_NAME line)

# Restart all agents in sequence (stagger to avoid gaps)
cortextos bus list-agents --format json | jq -r '.[].name' | while read agent; do
  echo "Restarting $agent..."
  cortextos bus send-message "$agent" high "hard-restart" "secret rotation: KEY_NAME"
  sleep 30
done

# Log the rotation
cortextos bus log-event action secret_rotated info \
  --meta "{\"key\":\"KEY_NAME\",\"scope\":\"org\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

### Rotating an Agent-Specific Secret

```bash
AGENT_ENV="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/AGENT_NAME/.env"
# Update the value in the file
chmod 600 "$AGENT_ENV"

# Hard-restart that agent (not soft — PTY must rebuild env)
cortextos bus send-message AGENT_NAME high "hard-restart" "secret rotation: KEY_NAME"

cortextos bus log-event action secret_rotated info \
  --meta "{\"key\":\"KEY_NAME\",\"scope\":\"agent\",\"agent\":\"AGENT_NAME\"}"
```

### Rotating a Bot Token (BOT_TOKEN)

1. Go to @BotFather → `/mybots` → select the bot → `API Token` → `Revoke current token`
2. Copy the new token
3. Update `agents/{agent}/.env` — replace `BOT_TOKEN=` value
4. Hard-restart the agent immediately (old token is already invalid)

---

## Critical Rules

1. **Never print secret values** — log key names only, never values
2. **Never commit .env files** — they are in .gitignore by design
3. **Always chmod 600** after writing any .env file
4. **Never edit a running agent's .env without restarting** — changes won't take effect until the PTY env is rebuilt
5. **Never add BOT_TOKEN to org .env** — each agent must have its own Telegram bot
6. **ANTHROPIC_API_KEY lives only in the shell** — do not add to any .env file
7. **Always hard-restart after rotating** — soft-restart preserves the PTY env which still has the old value
