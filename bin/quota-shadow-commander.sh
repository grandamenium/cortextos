#!/usr/bin/env bash
# Shadow-mode quota decision logger. Never starts or stops agents.

set -uo pipefail

: "${CTX_ROOT:?Set CTX_ROOT explicitly}"
: "${CTX_FRAMEWORK_ROOT:?Set CTX_FRAMEWORK_ROOT explicitly}"
: "${CTX_ORG:?Set CTX_ORG explicitly}"

THRESHOLD_PCT="${QUOTA_THRESHOLD_PCT:-10}"
RESUME_PCT="${QUOTA_RESUME_PCT:-50}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-orchestrator}"
STATE_DIR="$CTX_ROOT/state/quota-watchdog-shadow"
LOG="$STATE_DIR/shadow.log"

mkdir -p "$STATE_DIR"

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS="${CORTEXTOS_BIN:-cortextos}"
JQ="${JQ_BIN:-jq}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

if ! api_out="$("$CORTEXTOS" bus check-usage-api --json 2>> "$LOG")"; then
  log "usage API unavailable, decision=no-action"
  exit 0
fi

five_hour="$(printf '%s' "$api_out" | "$JQ" -r '.five_hour_utilization // empty')"
if [ -z "$five_hour" ]; then
  log "usage API returned no five_hour_utilization, decision=no-action"
  exit 0
fi

remaining="$(awk -v u="$five_hour" 'BEGIN { p = (1-u)*100; if (p<0) p=0; if (p>100) p=100; printf "%.0f", p }')"
paused_file="$CTX_ROOT/state/quota-watchdog/paused.json"
paused="no"
[ -f "$paused_file" ] && paused="yes"

decision="no-action"
if [ "$paused" = "no" ] && [ "$remaining" -lt "$THRESHOLD_PCT" ]; then
  decision="would-pause"
elif [ "$paused" = "yes" ] && [ "$remaining" -gt "$RESUME_PCT" ]; then
  decision="would-resume"
fi

log "remaining=${remaining}% paused=$paused decision=$decision"
exit 0
