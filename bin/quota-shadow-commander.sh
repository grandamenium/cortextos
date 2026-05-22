#!/bin/bash
# quota-shadow-commander.sh — Watchdog v3 Phase 1 (shadow mode, no broadcasts).
#
# Simulates what commander's heartbeat-cadence quota check WOULD decide,
# without actually broadcasting QUOTA_PAUSE/RESUME or modifying any agent
# state. Logs decisions to a shadow log so we can compare against the
# 5-min bash watchdog (v1+v2) over 24h+ and validate the agent-driven
# trigger logic agrees before advancing to Phase 2.
#
# Tunables (env):
#   QUOTA_PAUSE_THRESHOLD   — % below which commander would broadcast PAUSE (default 10)
#   QUOTA_RESUME_THRESHOLD  — % above which commander would broadcast RESUME (default 50)
#   CTX_ROOT                — cortextos state root (default /root/.cortextos/default)
#
# Designed to run from system crontab every 4h (commander's heartbeat
# cadence). NEVER spawns a Claude session — pure shell + bus CLI.
#
# Companion to /root/cortextos/bin/quota-watchdog.sh (v1+v2 bash failsafe).
# Once Phase 1 validates, this script is retired in favour of commander
# directly running the check + broadcasting via bus messages (Phase 2+).

set -uo pipefail

THRESHOLD_PAUSE_PCT="${QUOTA_PAUSE_THRESHOLD:-10}"
THRESHOLD_RESUME_PCT="${QUOTA_RESUME_THRESHOLD:-50}"

CTX_ROOT="${CTX_ROOT:-/root/.cortextos/default}"
STATE_DIR="$CTX_ROOT/state/quota-watchdog-v3-shadow"
LOG="$STATE_DIR/shadow.log"
mkdir -p "$STATE_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

CORTEXTOS=/usr/bin/cortextos
JQ=/usr/bin/jq
CLAUDE_CREDS=/root/.claude/.credentials.json

# Reuse the OAuth fallback the v1 watchdog uses
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$CLAUDE_CREDS" ]; then
  TOK=$("$JQ" -r '.claudeAiOauth.accessToken // empty' "$CLAUDE_CREDS" 2>/dev/null)
  [ -n "$TOK" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOK"
fi

# Bus needs an agent context for env resolution
export CTX_AGENT_NAME=commander
export CTX_ROOT
export CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/root/cortextos}"
export CTX_ORG="${CTX_ORG:-sondre-hq}"

log "=== shadow-check start (pause<${THRESHOLD_PAUSE_PCT}%, resume>${THRESHOLD_RESUME_PCT}%) ==="

# Read remaining %
if ! API_OUT=$("$CORTEXTOS" bus check-usage-api --json 2>/dev/null); then
  log "  API unavailable → would default to no-action (no token, no decision)"
  log "=== shadow-check end ==="
  exit 0
fi
FIVE_H=$(echo "$API_OUT" | "$JQ" -r '.five_hour_utilization // empty')
if [ -z "$FIVE_H" ] || [ "$FIVE_H" = "null" ]; then
  log "  API returned no 5h util → would default to no-action"
  log "=== shadow-check end ==="
  exit 0
fi

REMAINING_PCT=$(awk -v u="$FIVE_H" 'BEGIN { p = (1-u)*100; if (p<0) p=0; printf "%.0f", p }')

# Mirror v1+v2 watchdog's paused-state check
PAUSED_FILE="$CTX_ROOT/state/quota-watchdog/paused.json"
if [ -f "$PAUSED_FILE" ]; then
  PAUSED=yes
else
  PAUSED=no
fi

# Decide what commander WOULD do
DECISION="no-action"
if [ "$PAUSED" = "no" ] && [ "$REMAINING_PCT" -lt "$THRESHOLD_PAUSE_PCT" ]; then
  DECISION="would-broadcast-PAUSE"
elif [ "$PAUSED" = "yes" ] && [ "$REMAINING_PCT" -gt "$THRESHOLD_RESUME_PCT" ]; then
  DECISION="would-broadcast-RESUME"
fi

log "remaining=${REMAINING_PCT}% paused=$PAUSED → decision=$DECISION"
log "=== shadow-check end ==="
exit 0
