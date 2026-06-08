#!/bin/bash
# Per-agent silence watchdog for cortextOS.
# Detects agents whose process is alive but stuck (stdout idle while daemon is
# still injecting messages), and restarts JUST that agent — not the whole
# daemon. Avoids the cascade restart pattern that triggers BUG-011 (#296).
#
# Runs every 5 minutes via launchd. See README.md for install instructions.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
DAEMON_LOG="${PM2_HOME:-$HOME/.pm2}/logs/cortextos-daemon-out.log"
LOG_FILE="$HOME/.cortextos/$INSTANCE/logs/agent-recover.log"
STATE_DIR="$HOME/.cortextos/$INSTANCE/agent-recover-state"

# Tunables
IDLE_THRESHOLD_SEC="${AGENT_IDLE_THRESHOLD_SEC:-360}"   # 6 minutes
COOLDOWN_SEC="${AGENT_COOLDOWN_SEC:-1200}"              # 20 minutes per-agent

JQ_BIN="$(command -v jq)"
[ -z "$JQ_BIN" ] && { echo "agent-recover: jq not on PATH" >&2; exit 1; }

# Auto-detect alert bot. Override with CORTEXTOS_ALERT_BOT_ENV=/path/to/.env
ALERT_BOT_ENV="${CORTEXTOS_ALERT_BOT_ENV:-}"
if [ -z "$ALERT_BOT_ENV" ]; then
  # Find first enabled orchestrator's .env via context.json
  for ctx in "$FRAMEWORK_ROOT"/orgs/*/context.json; do
    [ -f "$ctx" ] || continue
    orch=$("$JQ_BIN" -r '.orchestrator // empty' "$ctx")
    [ -z "$orch" ] && continue
    org=$(basename "$(dirname "$ctx")")
    candidate="$FRAMEWORK_ROOT/orgs/$org/agents/$orch/.env"
    [ -f "$candidate" ] && ALERT_BOT_ENV="$candidate" && break
  done
fi

BOT_TOKEN=""
CHAT_ID=""
if [ -n "$ALERT_BOT_ENV" ] && [ -f "$ALERT_BOT_ENV" ]; then
  BOT_TOKEN=$(grep -E "^BOT_TOKEN=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
  CHAT_ID=$(grep -E "^CHAT_ID=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
fi

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"
now=$(date +%s)

# Gather enabled agents from registry
enabled_json="$HOME/.cortextos/$INSTANCE/config/enabled-agents.json"
[ -f "$enabled_json" ] || { echo "[$ts] enabled-agents.json missing — skip" >> "$LOG_FILE"; exit 0; }

agents=$("$JQ_BIN" -r 'to_entries[] | select(.value.enabled == true) | .key' "$enabled_json")

# Pull recent daemon log once (avoid re-reading per agent)
recent_log=$(tail -300 "$DAEMON_LOG" 2>/dev/null)

restarted=()

for agent in $agents; do
  stdout="$HOME/.cortextos/$INSTANCE/logs/$agent/stdout.log"
  [ -f "$stdout" ] || continue

  # PID via cortextos status
  pid=$(node "$FRAMEWORK_ROOT/dist/cli.js" status --instance "$INSTANCE" 2>/dev/null \
        | awk -v a="$agent" '$1 == a { print $3 }')
  [ -z "$pid" ] || [ "$pid" = "-" ] && continue

  # Process actually alive?
  kill -0 "$pid" 2>/dev/null || continue

  # Idle time for stdout
  stdout_mtime=$(stat -f "%m" "$stdout" 2>/dev/null || stat -c "%Y" "$stdout" 2>/dev/null)
  [ -z "$stdout_mtime" ] && continue
  idle=$((now - stdout_mtime))
  [ "$idle" -lt "$IDLE_THRESHOLD_SEC" ] && continue

  # Did the daemon inject anything for this agent recently?
  echo "$recent_log" | grep -q "\[$agent\] Injected" || continue

  # Cooldown check
  cooldown_file="$STATE_DIR/$agent.last-restart"
  if [ -f "$cooldown_file" ]; then
    last=$(cat "$cooldown_file")
    if [ $((now - last)) -lt "$COOLDOWN_SEC" ]; then
      echo "[$ts] $agent: hung (idle ${idle}s) but in cooldown — skip" >> "$LOG_FILE"
      continue
    fi
  fi

  # === Restart this agent ===
  echo "[$ts] $agent: HUNG — pid=$pid alive, stdout idle ${idle}s, daemon has injected messages. Restarting." >> "$LOG_FILE"
  node "$FRAMEWORK_ROOT/dist/cli.js" stop "$agent" --instance "$INSTANCE" >> "$LOG_FILE" 2>&1
  sleep 2
  node "$FRAMEWORK_ROOT/dist/cli.js" start "$agent" --instance "$INSTANCE" >> "$LOG_FILE" 2>&1
  echo "$now" > "$cooldown_file"
  restarted+=("$agent")
done

# Single Telegram alert if anything was restarted
if [ "${#restarted[@]}" -gt 0 ] && [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  list=$(printf ', %s' "${restarted[@]}")
  list=${list:2}
  msg="🔧 *Agent auto-recover*
Hung agents restarted: *${list}*
(Process was alive but stdout idle ≥ ${IDLE_THRESHOLD_SEC}s while messages queued. Auto-recovered without daemon-wide restart.)"

  curl -sS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id": %s, "text": %s, "parse_mode": "Markdown"}' "$CHAT_ID" "$(echo "$msg" | "$JQ_BIN" -Rs .)")" \
    >> "$LOG_FILE" 2>&1
fi

[ "${#restarted[@]}" -eq 0 ] && echo "[$ts] OK: all enabled agents healthy" >> "$LOG_FILE"
