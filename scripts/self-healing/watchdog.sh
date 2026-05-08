#!/bin/bash
# Daemon-level watchdog for cortextOS.
# Detects when the Telegram poller is wedged (accumulated fetch failures) and
# restarts cortextos-daemon via PM2 to clear stuck connections.
#
# Runs every 5 minutes via launchd. See README.md for install instructions.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
ERR_LOG="${PM2_HOME:-$HOME/.pm2}/logs/cortextos-daemon-error.log"
STATE_FILE="$HOME/.cortextos/$INSTANCE/watchdog-state"
LOG_FILE="$HOME/.cortextos/$INSTANCE/logs/watchdog.log"

# Threshold: if more than this many new poller-error lines appeared since the
# last check (≈5 min ago), assume wedge and restart. A healthy daemon produces
# 0–2 transient poll errors over 5 min; a wedged daemon spams hundreds.
THRESHOLD="${WATCHDOG_THRESHOLD:-150}"

PM2_BIN="$(command -v pm2)"
[ -z "$PM2_BIN" ] && { echo "watchdog: pm2 not on PATH" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

if [ ! -f "$ERR_LOG" ]; then
  echo "[$ts] err log missing: $ERR_LOG — skip" >> "$LOG_FILE"
  exit 0
fi

# Track only lines containing actual poller failures, not unrelated noise.
current=$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null || echo 0)
last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
delta=$(( current - last ))

# Handle log rotation (current < last)
[ "$delta" -lt 0 ] && delta="$current"

if [ "$delta" -gt "$THRESHOLD" ]; then
  echo "[$ts] WEDGED: $delta new poller errors since last check (threshold $THRESHOLD). Restarting cortextos-daemon." >> "$LOG_FILE"
  "$PM2_BIN" restart cortextos-daemon --update-env >> "$LOG_FILE" 2>&1
  # After restart, snapshot the new line count so we don't immediately re-fire.
  echo "$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null || echo 0)" > "$STATE_FILE"
else
  echo "[$ts] OK: $delta new poller errors (threshold $THRESHOLD)." >> "$LOG_FILE"
  echo "$current" > "$STATE_FILE"
fi
