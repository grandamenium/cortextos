#!/usr/bin/env bash
# send-telegram-guarded.sh — Telegram wrapper enforcing comms-discipline Rules 5 + 6.
#
# Drops the Telegram call when:
#   - identical text was sent to the same chat in the last 30 minutes (dedupe)
#   - text contains "online — ready" AND restart reason is session-refresh / user-restart
#
# Logs telegram_dedup_skipped event on every skip so suppressions are observable.
#
# Usage: bash scripts/comms/send-telegram-guarded.sh <chat_id> "<text>" [extra cortextos bus send-telegram flags...]
#
# Reads existing artifacts only — zero new infrastructure:
#   - ~/.cortextos/<instance>/logs/<agent>/last-telegram-<chat_id>.txt (populated by src/telegram/logging.ts)
#   - ~/.cortextos/<instance>/logs/<agent>/outbound-messages.jsonl    (populated by src/cli/bus.ts send-telegram)
#   - ~/.cortextos/<instance>/logs/<agent>/restarts.log               (populated by src/bus/system.ts)
#
# Full rationale: .claude/rules/comms-discipline.md

set -euo pipefail

DEDUP_WINDOW_SECONDS="${COMMS_DEDUP_WINDOW_SECONDS:-1800}"  # 30 min default

if [ $# -lt 2 ]; then
  echo "usage: $0 <chat_id> \"<text>\" [extra flags for cortextos bus send-telegram]" >&2
  exit 2
fi

chat_id="$1"
text="$2"
shift 2
extra_flags=("$@")

agent="${CTX_AGENT_NAME:-${CTX_AGENT:-}}"
instance="${CTX_INSTANCE_ID:-default}"
ctx_root="${CTX_ROOT:-$HOME/.cortextos/$instance}"

if [ -z "$agent" ]; then
  # Cannot dedupe without an agent-scoped cache; fall through to bare send.
  exec cortextos bus send-telegram "$chat_id" "$text" "${extra_flags[@]}"
fi

cache_file="$ctx_root/logs/$agent/last-telegram-$chat_id.txt"
out_log="$ctx_root/logs/$agent/outbound-messages.jsonl"
restarts_log="$ctx_root/logs/$agent/restarts.log"

log_skip() {
  local reason="$1"
  local preview
  preview="${text:0:60}"
  cortextos bus log-event action telegram_dedup_skipped info \
    --meta "{\"chat_id\":\"$chat_id\",\"text_preview\":$(printf '%s' "$preview" | jq -Rs .),\"reason\":\"$reason\"}" \
    >/dev/null 2>&1 || true
}

# --- Rule 5: restart-reason gate for "online — ready"-style pings ----------
# Use a substring match that tolerates both em-dash and hyphen formulations.
if printf '%s' "$text" | grep -qiE 'online[[:space:]]*[—-][[:space:]]*ready'; then
  if [ -f "$restarts_log" ]; then
    last_restart_line=$(tail -1 "$restarts_log" 2>/dev/null || true)
    # Lines look like "[<ts>] SELF-RESTART: <reason text...>" or "[<ts>] HARD-RESTART: <reason text...>".
    # Capture the full free-text reason, then keyword-match — restart reasons are
    # human-readable strings (e.g. "proactive session refresh — 6h cycle"), not
    # rigid enums.
    reason_full=$(printf '%s' "$last_restart_line" \
      | sed -nE 's/.*(SELF-RESTART|HARD-RESTART): *(.*)$/\2/p')
    reason_lower=$(printf '%s' "$reason_full" | tr '[:upper:]' '[:lower:]')
    if [ -n "$reason_lower" ] && printf '%s' "$reason_lower" \
        | grep -qE 'session[ -]refresh|user[ -](restart|stop|disable)|proactive|cron|routine[ -]restart'; then
      log_skip "restart_routine"
      exit 0
    fi
  fi
fi

# --- Rule 6: 30-min dedupe on identical text to same chat ------------------
if [ -f "$cache_file" ] && [ -f "$out_log" ]; then
  cached_text=$(cat "$cache_file" 2>/dev/null || true)
  if [ "$cached_text" = "$text" ]; then
    last_ts=$(tail -1 "$out_log" 2>/dev/null | jq -r '.timestamp // empty' 2>/dev/null || true)
    if [ -n "$last_ts" ]; then
      now_epoch=$(date -u +%s)
      # Convert ISO ts to epoch (macOS BSD date first, GNU fallback)
      last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$last_ts" "+%s" 2>/dev/null \
                    || date -u -d "$last_ts" +%s 2>/dev/null \
                    || echo 0)
      if [ "$last_epoch" -gt 0 ] && [ "$((now_epoch - last_epoch))" -lt "$DEDUP_WINDOW_SECONDS" ]; then
        log_skip "dup_text_${DEDUP_WINDOW_SECONDS}s"
        exit 0
      fi
    fi
  fi
fi

# --- Default: pass through to bare send-telegram ---------------------------
exec cortextos bus send-telegram "$chat_id" "$text" "${extra_flags[@]}"
