#!/bin/bash
# wedge-watchdog-liveness-watch.sh — who-watches-the-watcher for SYS-WEDGE-AUTORESTART.
#
# The wedge-watchdog (launchd com.cortextos.wedge-watchdog, ~5min) writes a liveness
# stamp to state/wedge-watchdog-last-fire each tick: "<ISO-ts> interval=<N>s".
# A dead/stalled watchdog reads as all-clear (silent-dead-detector masking, refinement-3
# class) UNLESS its own silence is caught. This closes that gap (PD shadow-condition a).
#
# Signal = the FILE (authoritative + self-calibrating via the embedded interval), NOT the
# best-effort bus event. Stale if now - ts > 2 x interval.
#
# Exit 0 = fresh. Exit 1 = STALE (probe died/stalled) -> route ALERT to platform-director.
# Exit 2 = file missing (probe not started OR intentionally removed) -> soft note, do NOT
#          hard-alarm (during shadow rollout the probe may legitimately be absent).
set -uo pipefail

LIVENESS="${CTX_ROOT:-$HOME/.cortextos/default}/state/wedge-watchdog-last-fire"

if [ ! -f "$LIVENESS" ]; then
  echo "WEDGE-WATCHDOG-LIVENESS: file MISSING ($LIVENESS) — probe not started or removed (shadow rollout may legitimately lack it). Soft note, not an alarm."
  exit 2
fi

read -r RESULT < <(python3 - "$LIVENESS" <<'PY'
import sys, re, datetime
path = sys.argv[1]
try:
    content = open(path).read().strip()
except Exception as e:
    print(f"ERR unreadable {e}"); sys.exit()
m_ts = re.match(r'(\S+)', content)
m_int = re.search(r'interval=(\d+)', content)
if not m_ts:
    print("ERR no-timestamp"); sys.exit()
try:
    ts = datetime.datetime.fromisoformat(m_ts.group(1).replace('Z', '+00:00'))
except Exception as e:
    print(f"ERR bad-timestamp {e}"); sys.exit()
interval = int(m_int.group(1)) if m_int else 300
now = datetime.datetime.now(datetime.timezone.utc)
age = int((now - ts).total_seconds())
threshold = 2 * interval
status = "STALE" if age > threshold else "FRESH"
print(f"{status} {age} {threshold} {interval} {m_ts.group(1)}")
PY
)

STATUS=$(echo "$RESULT" | awk '{print $1}')
AGE=$(echo "$RESULT" | awk '{print $2}')
THRESH=$(echo "$RESULT" | awk '{print $3}')
INTERVAL=$(echo "$RESULT" | awk '{print $4}')
LASTTS=$(echo "$RESULT" | awk '{print $5}')

if [ "$STATUS" = "ERR" ] || [ -z "$STATUS" ]; then
  echo "WEDGE-WATCHDOG-LIVENESS: PARSE-ERROR on $LIVENESS ($RESULT) — treat as probe-blind, do NOT fire."
  exit 2
fi

if [ "$STATUS" = "STALE" ]; then
  echo "WEDGE-WATCHDOG-LIVENESS: STALE — last fire ${AGE}s ago (> 2x interval ${THRESH}s). The wedge-detector probe DIED/STALLED = it is silently NOT running (a dead detector reads as all-clear). Route to platform-director."
  echo "{\"probe\":\"wedge-watchdog\",\"status\":\"STALE\",\"ageSec\":${AGE},\"thresholdSec\":${THRESH},\"intervalSec\":${INTERVAL},\"lastFire\":\"${LASTTS}\"}"
  exit 1
fi

echo "WEDGE-WATCHDOG-LIVENESS: fresh (last fire ${AGE}s ago < 2x interval ${THRESH}s, interval=${INTERVAL}s) — wedge-detector alive."
exit 0
