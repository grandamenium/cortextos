#!/usr/bin/env bash
# Dry-run-first Claude quota watchdog.
#
# Intended for cron. Requires explicit CTX_* environment variables so it cannot
# accidentally target the wrong instance or org. By default it only logs and
# notifies orchestrator; set QUOTA_DRY_RUN=0 to stop/start agents.

set -uo pipefail

: "${CTX_ROOT:?Set CTX_ROOT explicitly}"
: "${CTX_FRAMEWORK_ROOT:?Set CTX_FRAMEWORK_ROOT explicitly}"
: "${CTX_ORG:?Set CTX_ORG explicitly}"

THRESHOLD_PCT="${QUOTA_THRESHOLD_PCT:-10}"
RESUME_PCT="${QUOTA_RESUME_PCT:-50}"
DRY_RUN="${QUOTA_DRY_RUN:-1}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-orchestrator}"
ORCHESTRATOR_AGENT="${CTX_ORCHESTRATOR_AGENT:-orchestrator}"

STATE_DIR="$CTX_ROOT/state/quota-watchdog"
PAUSED_FILE="$STATE_DIR/paused.json"
LOG="$STATE_DIR/watchdog.log"

mkdir -p "$STATE_DIR"

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS="${CORTEXTOS_BIN:-cortextos}"
JQ="${JQ_BIN:-jq}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

send_orchestrator() {
  "$CORTEXTOS" bus send-message "$ORCHESTRATOR_AGENT" normal "$1" >> "$LOG" 2>&1 || true
}

usage_json() {
  "$CORTEXTOS" bus check-usage-api --json 2>> "$LOG"
}

json_num() {
  "$JQ" -r "$1 // empty" 2>/dev/null
}

remaining_pct() {
  awk -v u="$1" 'BEGIN { p = (1-u)*100; if (p<0) p=0; if (p>100) p=100; printf "%.0f", p }'
}

running_agents_json() {
  "$CORTEXTOS" list-agents --format json 2>> "$LOG" \
    | "$JQ" -c '[.[] | select(.org == env.CTX_ORG and .enabled == true and .running == true and .name != env.BUS_AGENT) | .name]'
}

pause_agents() {
  local agents_json="$1"
  local count
  count=$(printf '%s' "$agents_json" | "$JQ" 'length')
  [ "$count" -eq 0 ] && return 0

  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run pause skipped for $count agents"
    return 0
  fi

  printf '%s' "$agents_json" | "$JQ" -r '.[]' | while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    "$CORTEXTOS" stop "$agent" >> "$LOG" 2>&1 || log "stop failed: $agent"
  done
}

resume_agents() {
  local agents_json="$1"
  local count
  count=$(printf '%s' "$agents_json" | "$JQ" 'length')
  [ "$count" -eq 0 ] && return 0

  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run resume skipped for $count agents"
    return 0
  fi

  printf '%s' "$agents_json" | "$JQ" -r '.[]' | while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    "$CORTEXTOS" start "$agent" >> "$LOG" 2>&1 || log "start failed: $agent"
  done
}

log "quota-watchdog start dry_run=$DRY_RUN threshold=$THRESHOLD_PCT resume=$RESUME_PCT"

if ! api_out="$(usage_json)"; then
  log "usage API unavailable"
  exit 0
fi

five_hour="$(printf '%s' "$api_out" | json_num '.five_hour_utilization')"
if [ -z "$five_hour" ]; then
  log "usage API returned no five_hour_utilization"
  exit 0
fi

remaining="$(remaining_pct "$five_hour")"
paused="no"
[ -f "$PAUSED_FILE" ] && paused="yes"
log "remaining=${remaining}% paused=$paused"

if [ "$paused" = "no" ] && [ "$remaining" -lt "$THRESHOLD_PCT" ]; then
  agents="$(running_agents_json)"
  count="$(printf '%s' "$agents" | "$JQ" 'length')"
  pause_agents "$agents"
  if [ "$DRY_RUN" != "1" ]; then
    printf '{"paused_at":"%s","remaining_pct":%s,"agents_paused":%s}\n' "$(ts)" "$remaining" "$agents" > "$PAUSED_FILE"
  fi
  "$CORTEXTOS" bus log-event action quota_watchdog_pause warning \
    --meta "{\"dry_run\":\"$DRY_RUN\",\"remaining_pct\":$remaining,\"agents\":$agents}" >> "$LOG" 2>&1 || true
  send_orchestrator "Quota watchdog would pause $count agents: ${remaining}% remaining in the 5h window. dry_run=$DRY_RUN."
  exit 0
fi

if [ "$paused" = "yes" ] && [ "$remaining" -gt "$RESUME_PCT" ]; then
  agents="$( "$JQ" -c '.agents_paused // []' "$PAUSED_FILE" 2>/dev/null || printf '[]' )"
  count="$(printf '%s' "$agents" | "$JQ" 'length')"
  resume_agents "$agents"
  if [ "$DRY_RUN" != "1" ]; then
    mkdir -p "$STATE_DIR/history"
    mv "$PAUSED_FILE" "$STATE_DIR/history/paused-$(ts).json"
  fi
  "$CORTEXTOS" bus log-event action quota_watchdog_resume info \
    --meta "{\"dry_run\":\"$DRY_RUN\",\"remaining_pct\":$remaining,\"agents\":$agents}" >> "$LOG" 2>&1 || true
  send_orchestrator "Quota watchdog would resume $count agents: ${remaining}% remaining in the 5h window. dry_run=$DRY_RUN."
fi

exit 0
