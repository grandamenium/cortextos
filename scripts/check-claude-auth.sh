#!/usr/bin/env bash
# check-claude-auth.sh — run `claude auth status` and alert via Telegram on logged-out.
# Fires every 4h on MacBook via launchd; reads sam .env for BOT_TOKEN + CHAT_ID.
#
# Exit 0 always (silent on healthy). Telegram alert on auth-loss.

set -uo pipefail

export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin
LOG=/Users/hari/cortextos/scripts/check-claude-auth.log
SAM_ENV=/Users/hari/cortextos/orgs/subbu-ops/agents/sam/.env

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; }
log "tick"

if ! command -v claude >/dev/null 2>&1; then
  log "ERROR: claude binary not in PATH; nothing to check"
  exit 0
fi

# `claude auth status` outputs human-readable text + a logged-in indicator.
# Parse multiple possible formats — older versions print "Logged in as", newer
# emit JSON if --json is passed. Try JSON first, fall back to substring.
out_json=$(claude auth status --json 2>&1) || true
logged_in="unknown"
if echo "$out_json" | grep -q '"loggedIn"\s*:\s*true'; then logged_in=true
elif echo "$out_json" | grep -q '"loggedIn"\s*:\s*false'; then logged_in=false
else
  out_text=$(claude auth status 2>&1) || true
  case "$out_text" in
    *"Logged in"*|*"logged in as"*) logged_in=true ;;
    *"Not logged in"*|*"Please log in"*|*"401"*|*"Unauthorized"*) logged_in=false ;;
  esac
fi

log "auth status: loggedIn=$logged_in"

if [ "$logged_in" != "false" ]; then
  exit 0
fi

# Auth is missing — alert via Telegram. Pull token/chat from sam .env.
if [ ! -f "$SAM_ENV" ]; then
  log "ERROR: sam .env not at $SAM_ENV; cannot send Telegram alert"
  exit 0
fi
. "$SAM_ENV"
if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
  log "ERROR: BOT_TOKEN or CHAT_ID missing in sam .env; cannot send alert"
  exit 0
fi

msg="HARPAL alert: claude CLI on MacBook is logged OUT. Run 'claude auth login' interactively to re-authenticate; sam will resume normal operation once auth lands. Detected at $(date -u '+%Y-%m-%dT%H:%M:%SZ')."
curl -s -m 10 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=$msg" >/dev/null 2>&1 \
  && log "alert sent" \
  || log "alert send FAILED"

exit 0
