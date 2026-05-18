#!/bin/bash
# quota-watchdog.sh — system-cron-driven Claude quota watchdog with auto-resume.
#
# Pauses every running cortextOS agent when the 5h-window quota drops below
# QUOTA_THRESHOLD_PCT (default 10%). Auto-resumes them once the window has
# refilled past QUOTA_RESUME_PCT (default 50%). Designed to run from system
# crontab every 5 minutes. NEVER spawns a Claude session — pure shell + bus
# CLI + ccusage.
#
# Tunables (env):
#   QUOTA_THRESHOLD_PCT  — pause when remaining_pct <  this value (default: 10)
#   QUOTA_RESUME_PCT     — auto-resume when remaining_pct > this (default: 50)
#   QUOTA_DRY_RUN        — "1" to log+telegram but skip stop/start/state-write
#   CTX_ROOT             — cortextos state root (default: /root/.cortextos/default)
#   CTX_FRAMEWORK_ROOT   — cortextos framework root (default: /root/cortextos)
#   CTX_ORG              — org name for bus calls (default: sondre-hq)
#   WATCHDOG_BUS_AGENT   — agent context for bus telegram/event calls (default: commander)
#   WATCHDOG_CHAT_ID     — Sondre's chat id (default: 8654231106)
#
# Exit codes: 0 always (cron-friendly). All errors logged.

set -uo pipefail

THRESHOLD_PCT="${QUOTA_THRESHOLD_PCT:-10}"
RESUME_PCT="${QUOTA_RESUME_PCT:-50}"
DRY_RUN="${QUOTA_DRY_RUN:-0}"

CTX_ROOT="${CTX_ROOT:-/root/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/root/cortextos}"
CTX_ORG="${CTX_ORG:-sondre-hq}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-commander}"
CHAT_ID="${WATCHDOG_CHAT_ID:-8654231106}"

STATE_DIR="$CTX_ROOT/state/quota-watchdog"
PAUSED_FILE="$STATE_DIR/paused.json"
CHECK_FILE="$STATE_DIR/last-check.json"
HISTORY_DIR="$STATE_DIR/history"
LOG="$STATE_DIR/watchdog.log"

mkdir -p "$STATE_DIR" "$HISTORY_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Bus-friendly env block — needed because cron has no agent context
export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS=/usr/bin/cortextos
JQ=/usr/bin/jq
CCUSAGE=/usr/bin/ccusage
CLAUDE_CREDS=/root/.claude/.credentials.json

# Auto-extract OAuth token from Claude Code's local credentials store if no
# accounts.json is configured and CLAUDE_CODE_OAUTH_TOKEN isn't already set.
# Claude Code refreshes that file automatically while any agent runs, so the
# watchdog gets fresh tokens for free.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
   && [ ! -f "$CTX_ROOT/state/oauth/accounts.json" ] \
   && [ -f "$CLAUDE_CREDS" ]; then
  TOK=$("$JQ" -r '.claudeAiOauth.accessToken // empty' "$CLAUDE_CREDS" 2>/dev/null)
  [ -n "$TOK" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOK"
fi

# ---------------------------------------------------------------------------
# 1. Determine remaining_pct — API is the ONLY authoritative source for
#    pause/resume decisions. ccusage was used as a fallback in v1+v2 but
#    that produced a real false-positive on 2026-05-07 09:35 UTC: API
#    transient failure → ccusage tripped 0% via "exceeds historical max"
#    heuristic → all 6 agents paused even though Sondre had 96% remaining.
#    Postmortem: vault/00-inbox/20260507-dev-quota-watchdog-ccusage-false-positive-postmortem.md
#
#    New policy (v3 — same script, tighter logic):
#    - API success → use it for pause/resume decisions (UNCHANGED).
#    - API failure → log + Telegram alert + DO NOT pause.
#      ccusage stays available as a sanity-check signal in the monitoring
#      log but is NEVER authoritative for pause/resume.
# ---------------------------------------------------------------------------
REMAINING_PCT=""
METHOD=""
API_AVAILABLE=no

# Path 1: official Anthropic usage API (the only authoritative source)
if API_OUT=$("$CORTEXTOS" bus check-usage-api --json 2>/dev/null); then
  FIVE_H=$(echo "$API_OUT" | "$JQ" -r '.five_hour_utilization // empty')
  if [ -n "$FIVE_H" ] && [ "$FIVE_H" != "null" ]; then
    REMAINING_PCT=$(awk -v u="$FIVE_H" 'BEGIN { p = (1-u)*100; if (p<0) p=0; printf "%.0f", p }')
    METHOD="api"
    API_AVAILABLE=yes
  fi
fi

# Sanity-check signal only — log ccusage's reading next to API for monitoring
# debugging, but never use it to drive pause/resume decisions.
CCUSAGE_PCT=""
if [ -x "$CCUSAGE" ]; then
  if CC_OUT=$("$CCUSAGE" blocks --active --json -t max 2>/dev/null); then
    CC_USED=$(echo "$CC_OUT" | "$JQ" -r '.blocks[0].tokenLimitStatus.percentUsed // empty')
    if [ -n "$CC_USED" ]; then
      CCUSAGE_PCT=$(awk -v u="$CC_USED" 'BEGIN { p = 100-u; if (p<0) p=0; printf "%.0f", p }')
    fi
  fi
fi

# If API path failed, alert + stay running (DO NOT auto-pause). The
# Sondre-impact of a false-positive pause is much worse than a brief
# blind window; quota tax during the blind window is bounded by burn rate.
if [ "$API_AVAILABLE" = "no" ]; then
  REMAINING_PCT=unknown
  METHOD="api-degraded"
  log "WARNING: API path unavailable. ccusage_signal=${CCUSAGE_PCT:-unavailable}%. Staying running per v3 policy — alert sent to operator."
  ALERT_MSG="⚠️ Quota watchdog API path degraded — ccusage signal=${CCUSAGE_PCT:-unavailable}%. Agents NOT paused (per v3 policy: pause only on API-confirmed below-threshold). Investigate manually if API path doesn't recover within the next cycle. Watchdog log: $LOG"
  # Only alert ONCE per degradation episode — don't spam Sondre on repeated cron ticks
  DEGRADED_FLAG="$STATE_DIR/.api-degraded-since"
  if [ ! -f "$DEGRADED_FLAG" ]; then
    "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$ALERT_MSG" --plain-text >> "$LOG" 2>&1 || log "  telegram alert failed"
    echo "$(ts)" > "$DEGRADED_FLAG"
  fi
  cat > "$CHECK_FILE" <<EOF
{
  "ts": "$(ts)",
  "method": "$METHOD",
  "remaining_pct": "unknown",
  "ccusage_signal_pct": ${CCUSAGE_PCT:-null},
  "paused": $([ -f "$PAUSED_FILE" ] && echo true || echo false)
}
EOF
  exit 0
fi

# API recovered — clear any stale degradation flag
[ -f "$STATE_DIR/.api-degraded-since" ] && rm -f "$STATE_DIR/.api-degraded-since"

cat > "$CHECK_FILE" <<EOF
{
  "ts": "$(ts)",
  "method": "$METHOD",
  "remaining_pct": $REMAINING_PCT,
  "ccusage_signal_pct": ${CCUSAGE_PCT:-null},
  "threshold_pct": $THRESHOLD_PCT,
  "resume_pct": $RESUME_PCT,
  "paused": $([ -f "$PAUSED_FILE" ] && echo true || echo false)
}
EOF

log "check method=$METHOD remaining=${REMAINING_PCT}% ccusage_signal=${CCUSAGE_PCT:-na}% threshold=${THRESHOLD_PCT}% resume=${RESUME_PCT}% paused=$([ -f "$PAUSED_FILE" ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# 2. Branch: if paused.json exists → maybe auto-resume; else → maybe pause
# ---------------------------------------------------------------------------

if [ -f "$PAUSED_FILE" ]; then
  # ---- Already paused: should we auto-resume? ----
  # API-degraded path stays paused — never resume on a guess (we already
  # exited in the API-degraded branch above before reaching here, but
  # belt-and-suspenders).
  if [ "$METHOD" != "api" ]; then
    log "still paused; method=$METHOD non-authoritative, holding pause"
    exit 0
  fi

  if [ "$REMAINING_PCT" -le "$RESUME_PCT" ]; then
    log "still paused; remaining=${REMAINING_PCT}% <= resume=${RESUME_PCT}%, holding"
    exit 0
  fi

  # Auto-resume path
  log "AUTO-RESUME remaining=${REMAINING_PCT}% > resume=${RESUME_PCT}%"

  PAUSED_AT=$("$JQ" -r '.paused_at // empty' "$PAUSED_FILE" 2>/dev/null)
  AGENTS_JSON=$("$JQ" -c '.agents_paused // .agents // []' "$PAUSED_FILE" 2>/dev/null)
  [ -z "$AGENTS_JSON" ] && AGENTS_JSON='[]'
  COUNT=$(echo "$AGENTS_JSON" | "$JQ" 'length')

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: would auto-resume $COUNT agents and archive paused state"
    MSG="[dry-run] Quota watchdog WOULD auto-resume — remaining=${REMAINING_PCT}% > ${RESUME_PCT}%. $COUNT agents would be started: $(echo "$AGENTS_JSON" | "$JQ" -r 'join(", ")'). No action taken."
    "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" --plain-text >> "$LOG" 2>&1 || log "  telegram failed"
    exit 0
  fi

  echo "$AGENTS_JSON" | "$JQ" -r '.[]' | while IFS= read -r AGENT; do
    [ -z "$AGENT" ] && continue
    log "auto-resume start: $AGENT"
    "$CORTEXTOS" start "$AGENT" >> "$LOG" 2>&1 || log "  start failed: $AGENT"
  done

  # Archive paused state (keep for audit; do not delete)
  mv "$PAUSED_FILE" "$HISTORY_DIR/paused-$(ts).json"
  log "paused state archived; watchdog re-armed"

  "$CORTEXTOS" bus log-event action quota_watchdog_resume info \
    --meta "{\"remaining_pct\":$REMAINING_PCT,\"method\":\"$METHOD\",\"agents_resumed\":$AGENTS_JSON,\"paused_at\":\"$PAUSED_AT\",\"trigger\":\"auto\"}" \
    >> "$LOG" 2>&1 || log "  log-event failed"

  AGENT_LIST=$(echo "$AGENTS_JSON" | "$JQ" -r 'join(", ")')
  MSG="✅ Quota watchdog auto-resumed $COUNT agents — remaining ${REMAINING_PCT}% (above ${RESUME_PCT}% buffer). Started: $AGENT_LIST."
  "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" --plain-text >> "$LOG" 2>&1 || log "  telegram failed"

  log "AUTO-RESUMED $COUNT agents"
  exit 0
fi

# ---------------------------------------------------------------------------
# Not paused: should we trip?
# ---------------------------------------------------------------------------

if [ "$REMAINING_PCT" -ge "$THRESHOLD_PCT" ]; then
  exit 0
fi

log "TRIGGER remaining=${REMAINING_PCT}% < ${THRESHOLD_PCT}%"

# Snapshot running agents
RUNNING_JSON='[]'
if AGENTS_OUT=$("$CORTEXTOS" bus list-agents 2>/dev/null); then
  RUNNING_JSON=$(echo "$AGENTS_OUT" | "$JQ" -c '[.[] | select(.running == true) | .name]')
  [ -z "$RUNNING_JSON" ] && RUNNING_JSON='[]'
fi
COUNT=$(echo "$RUNNING_JSON" | "$JQ" 'length')
log "running agents: $RUNNING_JSON (count=$COUNT)"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN: would stop $COUNT agents and write paused state"
  MSG="[dry-run] Quota watchdog WOULD trip — method=$METHOD remaining=${REMAINING_PCT}% (threshold ${THRESHOLD_PCT}%). $COUNT agents would be stopped: $(echo "$RUNNING_JSON" | "$JQ" -r 'join(", ")'). No action taken."
  "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" --plain-text >> "$LOG" 2>&1 || log "  telegram failed"
  exit 0
fi

# Stop each running agent
echo "$RUNNING_JSON" | "$JQ" -r '.[]' | while IFS= read -r AGENT; do
  [ -z "$AGENT" ] && continue
  log "stop: $AGENT"
  "$CORTEXTOS" stop "$AGENT" >> "$LOG" 2>&1 || log "  stop failed: $AGENT"
done

# Write paused-state file (schema: paused_at, agents_paused, remaining_pct_at_pause + extras)
cat > "$PAUSED_FILE" <<EOF
{
  "paused_at": "$(ts)",
  "agents_paused": $RUNNING_JSON,
  "remaining_pct_at_pause": $REMAINING_PCT,
  "method": "$METHOD",
  "threshold_pct": $THRESHOLD_PCT,
  "resume_pct": $RESUME_PCT
}
EOF
log "paused-state written: $PAUSED_FILE"

"$CORTEXTOS" bus log-event action quota_watchdog_pause warning \
  --meta "{\"remaining_pct\":$REMAINING_PCT,\"method\":\"$METHOD\",\"agents_stopped\":$RUNNING_JSON}" \
  >> "$LOG" 2>&1 || log "  log-event failed"

AGENT_LIST=$(echo "$RUNNING_JSON" | "$JQ" -r 'join(", ")')
MSG="🚨 Quota watchdog tripped. Method=$METHOD, remaining=${REMAINING_PCT}% (threshold ${THRESHOLD_PCT}%). Stopped $COUNT agents: $AGENT_LIST. Will auto-resume once remaining > ${RESUME_PCT}%, or run /root/cortextos/bin/quota-resume.sh manually."
"$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" --plain-text >> "$LOG" 2>&1 || log "  telegram failed"

log "PAUSED $COUNT agents"
exit 0
