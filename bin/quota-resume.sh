#!/bin/bash
# quota-resume.sh — manual companion to quota-watchdog.sh.
#
# Reads the paused-state file written by quota-watchdog.sh and starts every
# agent that the watchdog stopped. Idempotent: removes the state file on
# success so the next watchdog tick is allowed to run again.
#
# Usage:
#   /root/cortextos/bin/quota-resume.sh           # resume all paused agents
#   /root/cortextos/bin/quota-resume.sh --status  # show paused state without resuming
#
# Tunables (env):
#   CTX_ROOT             — cortextos state root (default: /root/.cortextos/default)
#   CTX_FRAMEWORK_ROOT   — cortextos framework root (default: /root/cortextos)
#   CTX_ORG              — org name for bus calls (default: sondre-hq)
#   WATCHDOG_BUS_AGENT   — agent context for bus calls (default: commander)
#   WATCHDOG_CHAT_ID     — Sondre's chat id (default: 8654231106)

set -uo pipefail

CTX_ROOT="${CTX_ROOT:-/root/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/root/cortextos}"
CTX_ORG="${CTX_ORG:-sondre-hq}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-commander}"
CHAT_ID="${WATCHDOG_CHAT_ID:-8654231106}"

STATE_DIR="$CTX_ROOT/state/quota-watchdog"
PAUSED_FILE="$STATE_DIR/paused.json"
LOG="$STATE_DIR/watchdog.log"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] resume: $*" >> "$LOG"; }

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS=/usr/bin/cortextos
JQ=/usr/bin/jq

if [ ! -f "$PAUSED_FILE" ]; then
  echo "No paused state at $PAUSED_FILE — watchdog has not tripped (or already resumed)."
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  "$JQ" . "$PAUSED_FILE"
  exit 0
fi

PAUSED_AT=$("$JQ" -r .paused_at "$PAUSED_FILE")
# v2 schema: agents_paused; v1 schema: agents — accept both
AGENTS_JSON=$("$JQ" -c '.agents_paused // .agents // []' "$PAUSED_FILE")
COUNT=$(echo "$AGENTS_JSON" | "$JQ" 'length')

echo "Resuming $COUNT agents (paused at $PAUSED_AT):"
log "resume requested: $COUNT agents (paused_at=$PAUSED_AT)"

FAILED=()
echo "$AGENTS_JSON" | "$JQ" -r '.[]' | while IFS= read -r AGENT; do
  [ -z "$AGENT" ] && continue
  echo "  starting: $AGENT"
  if "$CORTEXTOS" start "$AGENT" >> "$LOG" 2>&1; then
    log "  started: $AGENT"
  else
    log "  start failed: $AGENT"
    FAILED+=("$AGENT")
  fi
done

# Archive the paused-state file rather than delete (auditability)
ARCHIVE_DIR="$STATE_DIR/history"
mkdir -p "$ARCHIVE_DIR"
mv "$PAUSED_FILE" "$ARCHIVE_DIR/paused-$(ts).json"
log "paused state archived; watchdog re-armed"

"$CORTEXTOS" bus log-event action quota_watchdog_resume info \
  --meta "{\"agents_resumed\":$AGENTS_JSON,\"paused_at\":\"$PAUSED_AT\"}" \
  >> "$LOG" 2>&1 || true

AGENT_LIST=$(echo "$AGENTS_JSON" | "$JQ" -r 'join(", ")')
MSG="✅ Quota watchdog resumed. Started $COUNT agents: $AGENT_LIST."
"$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" --plain-text >> "$LOG" 2>&1 || true

echo "Done. Watchdog re-armed."
exit 0
