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

# Threshold: a window "trips" if more than this many new poller-error lines
# appeared since the last check (≈5 min ago). The poller now rate-limits its
# error logging to ≈1 line / 30s (see TelegramPoller.POLL_ERROR_LOG_INTERVAL_MS),
# so a sustained outage produces at most ~10 lines / 5 min — this threshold is
# tuned for that rate-limited volume, NOT the pre-rate-limit raw spam (was 150).
THRESHOLD="${WATCHDOG_THRESHOLD:-5}"

# Require this many CONSECUTIVE tripped windows before restarting. A transient
# Telegram outage (the poller rides it out with catch+retry) trips one window
# then clears — strikes reset, no restart. A genuinely wedged poller stays
# tripped across windows. With 5-min windows, N=2 ⇒ ~10 min sustained before a
# restart, eliminating spurious restarts on short/transient outages.
CONSECUTIVE="${WATCHDOG_CONSECUTIVE:-2}"

# launchd starts this script with a stripped PATH (≈/usr/bin:/bin:/usr/sbin:/sbin).
# The restart below uses `--update-env`, which pushes THIS process's PATH into the
# daemon. Without augmentation that poisons the daemon's PATH: it loses ~/.local/bin
# (where `claude` lives) and ~/.npm-global/bin (where `cortextos` lives), so the
# daemon can no longer spawn agent PTYs (node-pty → ENOENT) or run its heartbeat
# `cortextos` shell-out — the fleet goes "running"-but-dead after the restart.
# Prepend the user-local bins so --update-env carries a healthy PATH.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PM2_BIN="$(command -v pm2)"
[ -z "$PM2_BIN" ] && { echo "watchdog: pm2 not on PATH" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

if [ ! -f "$ERR_LOG" ]; then
  echo "[$ts] err log missing: $ERR_LOG — skip" >> "$LOG_FILE"
  exit 0
fi

# Track only lines containing actual poller failures, not unrelated noise.
current=$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null || true)
current="${current:-0}"

# STATE_FILE format: "<last_count> <consecutive_strikes>". Backward-compatible
# with the old single-field format (just "<last_count>") — strikes defaults 0.
last=0; strikes=0
if [ -f "$STATE_FILE" ]; then
  read -r last strikes < "$STATE_FILE" || true
  last="${last:-0}"; strikes="${strikes:-0}"
fi

delta=$(( current - last ))
# Handle log rotation (current < last)
[ "$delta" -lt 0 ] && delta="$current"

if [ "$delta" -gt "$THRESHOLD" ]; then
  strikes=$(( strikes + 1 ))
  if [ "$strikes" -ge "$CONSECUTIVE" ]; then
    echo "[$ts] WEDGED: $delta new poller errors (threshold $THRESHOLD), $strikes consecutive tripped windows (>= $CONSECUTIVE). Restarting cortextos-daemon." >> "$LOG_FILE"
    "$PM2_BIN" restart cortextos-daemon --update-env >> "$LOG_FILE" 2>&1
    # Re-snapshot the post-restart count and reset the strike counter.
    current=$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null || true)
current="${current:-0}"
    strikes=0
  else
    echo "[$ts] TRIPPED: $delta new poller errors (threshold $THRESHOLD), strike $strikes/$CONSECUTIVE — not restarting yet." >> "$LOG_FILE"
  fi
else
  if [ "$strikes" -ne 0 ]; then
    echo "[$ts] RECOVERED: $delta new poller errors (threshold $THRESHOLD) — was at strike $strikes, resetting." >> "$LOG_FILE"
  else
    echo "[$ts] OK: $delta new poller errors (threshold $THRESHOLD)." >> "$LOG_FILE"
  fi
  strikes=0
fi
echo "$current $strikes" > "$STATE_FILE"
