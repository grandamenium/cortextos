#!/bin/bash
# Claude Code usage monitor for cortextOS.
# Computes current 5-hour Claude Code session-block burn rate from ccusage and
# Telegram-alerts on tier transitions. Fires alerts only on entering a new
# tier (or while in RED) — won't spam.
#
# Tiers (tunable below):
#   GREEN  : < $15/hr        — silent, log only
#   YELLOW : $15–$30/hr      — Telegram alert (once per state transition)
#   RED    : > $30/hr        — Telegram alert (every check while elevated)
#
# Runs every 30 minutes via launchd. See README.md for install instructions.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
STATE_FILE="$HOME/.cortextos/$INSTANCE/usage-monitor-state"
LOG_FILE="$HOME/.cortextos/$INSTANCE/logs/usage-monitor.log"

# Thresholds (USD/hr)
YELLOW_THRESHOLD="${USAGE_YELLOW_THRESHOLD:-15}"
RED_THRESHOLD="${USAGE_RED_THRESHOLD:-30}"

CCUSAGE_BIN="$(command -v ccusage)"
JQ_BIN="$(command -v jq)"
[ -z "$CCUSAGE_BIN" ] && { echo "usage-monitor: ccusage not on PATH (npm install -g ccusage)" >&2; exit 1; }
[ -z "$JQ_BIN" ] && { echo "usage-monitor: jq not on PATH" >&2; exit 1; }

# Auto-detect alert bot. Override with CORTEXTOS_ALERT_BOT_ENV=/path/to/.env
ALERT_BOT_ENV="${CORTEXTOS_ALERT_BOT_ENV:-}"
if [ -z "$ALERT_BOT_ENV" ]; then
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

mkdir -p "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

# Pull ccusage blocks JSON, isolate the active block
blocks_json=$("$CCUSAGE_BIN" blocks --json 2>/dev/null)
active=$(echo "$blocks_json" | "$JQ_BIN" -c '.blocks | map(select(.isActive == true)) | .[0] // empty')

if [ -z "$active" ]; then
  echo "[$ts] No active block — fleet is idle. Skipping check." >> "$LOG_FILE"
  exit 0
fi

cost=$(echo "$active" | "$JQ_BIN" -r '.costUSD')
start_iso=$(echo "$active" | "$JQ_BIN" -r '.startTime')
# Strip the .NNNZ suffix and parse as UTC
start_unix=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  start_unix=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${start_iso%.*}" +%s 2>/dev/null)
else
  start_unix=$(date -u -d "${start_iso}" +%s 2>/dev/null)
fi
now_unix=$(date +%s)
if [ -n "$start_unix" ]; then
  elapsed_min=$(( (now_unix - start_unix) / 60 ))
else
  elapsed_min=0
fi
projected_cost=$(echo "$active" | "$JQ_BIN" -r '.projection.totalCost // empty')

# Burn rate $/hr
if [ "$elapsed_min" -gt 0 ]; then
  rate=$(echo "$cost $elapsed_min" | awk '{printf "%.2f", ($1 * 60) / $2}')
else
  rate="0.00"
fi

# Determine current tier (use awk for portable float compare)
tier=$(awk -v r="$rate" -v y="$YELLOW_THRESHOLD" -v R="$RED_THRESHOLD" \
  'BEGIN { if (r >= R) print "RED"; else if (r >= y) print "YELLOW"; else print "GREEN" }')

last_tier=$(cat "$STATE_FILE" 2>/dev/null || echo "GREEN")
echo "$tier" > "$STATE_FILE"

proj_str=""
[ -n "$projected_cost" ] && proj_str=" (projected block total: \$${projected_cost})"
echo "[$ts] tier=$tier rate=\$${rate}/hr cost=\$${cost} elapsed=${elapsed_min}m${proj_str}" >> "$LOG_FILE"

# Alert on tier change OR every check while RED
should_alert=0
[ "$tier" != "$last_tier" ] && should_alert=1
[ "$tier" = "RED" ] && should_alert=1

if [ "$should_alert" -eq 1 ] && [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  case "$tier" in
    RED)    icon="🔴" ;;
    YELLOW) icon="🟡" ;;
    GREEN)  icon="🟢" ;;
  esac

  msg="${icon} *Usage Monitor — ${tier}*
Burn rate: *\$${rate}/hr*
Active block: \$${cost} so far over ${elapsed_min}m"

  [ -n "$projected_cost" ] && msg="${msg}
Projected for full 5h block: *\$${projected_cost}*"

  if [ "$tier" = "GREEN" ] && [ "$last_tier" != "GREEN" ]; then
    msg="${msg}

✅ Recovered to safe burn. (Was: ${last_tier})"
  elif [ "$tier" = "YELLOW" ]; then
    msg="${msg}

Watching. Run \`ccusage blocks\` for breakdown."
  elif [ "$tier" = "RED" ]; then
    msg="${msg}

🚨 High burn. Identify heavy agent (\`ccusage session\`), pause non-critical specialists, or stop the daemon."
  fi

  curl -sS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id": %s, "text": %s, "parse_mode": "Markdown"}' "$CHAT_ID" "$(echo "$msg" | "$JQ_BIN" -Rs .)")" \
    >> "$LOG_FILE" 2>&1
fi
