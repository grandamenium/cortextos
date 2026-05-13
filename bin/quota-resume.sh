#!/usr/bin/env bash
# Manual companion for quota-watchdog.sh. Requires explicit CTX_* env vars and
# defaults to dry-run so a misplaced invocation cannot restart agents.

set -uo pipefail

: "${CTX_ROOT:?Set CTX_ROOT explicitly}"
: "${CTX_FRAMEWORK_ROOT:?Set CTX_FRAMEWORK_ROOT explicitly}"
: "${CTX_ORG:?Set CTX_ORG explicitly}"

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
log() { printf '[%s] resume: %s\n' "$(ts)" "$*" >> "$LOG"; }

if [ ! -f "$PAUSED_FILE" ]; then
  echo "No paused state at $PAUSED_FILE."
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  "$JQ" . "$PAUSED_FILE"
  exit 0
fi

agents="$("$JQ" -c '.agents_paused // []' "$PAUSED_FILE")"
count="$(printf '%s' "$agents" | "$JQ" 'length')"
echo "Resuming $count agents. dry_run=$DRY_RUN"

if [ "$DRY_RUN" != "1" ]; then
  printf '%s' "$agents" | "$JQ" -r '.[]' | while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    "$CORTEXTOS" start "$agent" >> "$LOG" 2>&1 || log "start failed: $agent"
  done
  mkdir -p "$STATE_DIR/history"
  mv "$PAUSED_FILE" "$STATE_DIR/history/paused-$(ts).json"
else
  log "dry-run resume skipped for $count agents"
fi

"$CORTEXTOS" bus log-event action quota_watchdog_resume info \
  --meta "{\"dry_run\":\"$DRY_RUN\",\"agents\":$agents}" >> "$LOG" 2>&1 || true
"$CORTEXTOS" bus send-message "$ORCHESTRATOR_AGENT" normal \
  "Quota watchdog resume requested for $count agents. dry_run=$DRY_RUN." >> "$LOG" 2>&1 || true

echo "Done."
exit 0
