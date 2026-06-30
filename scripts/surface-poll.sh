#!/usr/bin/env bash
# surface-poll.sh — dumb-poll for seb_boss fleet surface watcher
# Runs via Windows Task Scheduler every 5min. ZERO LLM tokens on clear pass.
# Only spawns seb_boss session via bus send-message when a MAJOR event is detected.
#
# Created: 2026-05-19 per Sebastian directive (cost-aware autonomous monitoring).
# Migration: scripts/surface-poll.task.xml has scheduler config for restoration on new machine.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.surface-poll-state.json"
LOG_FILE="$SCRIPT_DIR/.surface-poll.log"
RELAYED_FILE="$SCRIPT_DIR/.surface-poll-relayed.jsonl"
CHAT_ID="8788724873"
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
INBOX_DIR="/c/Users/Sebas/.cortextos/default/inbox/seb_boss"
PROCESSED_DIR="/c/Users/Sebas/.cortextos/default/processed/seb_boss"
BRIDGE_DIR="$SCRIPT_DIR/.bus-to-chat-bridge"
BRIDGE_STATE="$BRIDGE_DIR/last-scan.txt"

# Append run-marker to log (always — used by hourly-pulse staleness audit)
echo "$NOW_UTC fire" >> "$LOG_FILE"

# STEP A — SELF-HEAL stale .lock.d on inbox (2026-05-21 fix: 6-day stuck lock caused 577 unread msgs)
# Stuck pattern: .lock.d exists but pid file empty/missing → acquireLock returns false silently
if [ -d "$INBOX_DIR/.lock.d" ]; then
  LOCK_MTIME=$(stat -c %Y "$INBOX_DIR/.lock.d" 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  LOCK_AGE=$(( NOW_EPOCH - LOCK_MTIME ))
  PID_FILE_SIZE=0
  if [ -f "$INBOX_DIR/.lock.d/pid" ]; then
    PID_FILE_SIZE=$(stat -c %s "$INBOX_DIR/.lock.d/pid" 2>/dev/null || echo 0)
  fi
  # If lock dir >1h old AND pid file empty/missing → clear it
  if [ "$LOCK_AGE" -gt 3600 ] && [ "$PID_FILE_SIZE" -eq 0 ]; then
    TRASH="/c/Users/Sebas/OneDrive/Documentos/07_Archive/claude-trash/$(date -u +%Y-%m-%d)/surface-poll-stale-lock-$NOW_UTC"
    mkdir -p "$TRASH"
    mv -f "$INBOX_DIR/.lock.d" "$TRASH/" 2>/dev/null && \
      echo "$NOW_UTC self_heal_stale_lock age=${LOCK_AGE}s -> trash" >> "$LOG_FILE"
  fi
fi

# STEP B — BUS-TO-CHAT BRIDGE (2026-05-21 fix: transient sessions consume bus messages, main CC never sees them)
# Scan processed/seb_boss/ for new HIGH-VALUE messages since last bridge run.
# Surface them to bridge dir so main-CC seb_boss reads them on cron-fire.
mkdir -p "$BRIDGE_DIR"
LAST_SCAN_TS=0
if [ -f "$BRIDGE_STATE" ]; then
  LAST_SCAN_TS=$(cat "$BRIDGE_STATE" 2>/dev/null || echo 0)
fi
SCAN_NOW=$(date +%s)
# Find processed messages newer than last scan
if [ -d "$PROCESSED_DIR" ]; then
  while IFS= read -r FILE; do
    [ -z "$FILE" ] && continue
    # Extract msg content; flag if HIGH/URGENT priority OR contains FINDING/IDEA/BLOCKED keywords
    PRIORITY=$(grep -oE '"priority":"[^"]+"' "$FILE" 2>/dev/null | head -1 | cut -d'"' -f4)
    FROM=$(grep -oE '"from":"[^"]+"' "$FILE" 2>/dev/null | head -1 | cut -d'"' -f4)
    TEXT_PREVIEW=$(grep -oE '"text":"[^"]{0,300}' "$FILE" 2>/dev/null | head -1 | sed 's/^"text":"//')
    # Surface conditions
    SURFACE=""
    if [ "$PRIORITY" = "urgent" ] || [ "$PRIORITY" = "high" ]; then
      SURFACE="priority=$PRIORITY"
    elif echo "$TEXT_PREVIEW" | grep -qiE "FINDING (high|med)|BLOCKED|NO-GO|capped|crashed|halt"; then
      SURFACE="content-pattern"
    fi
    if [ -n "$SURFACE" ]; then
      BRIDGE_OUT="$BRIDGE_DIR/$(date -u +%Y-%m-%dT%H-%M-%SZ)-${FROM}-$(basename "$FILE" .json).md"
      {
        echo "# Bus message from $FROM"
        echo "Surface reason: $SURFACE"
        echo "Source file: $FILE"
        echo "Scanned: $NOW_UTC"
        echo ""
        echo "## Content preview (first 300 chars)"
        echo "$TEXT_PREVIEW"
      } > "$BRIDGE_OUT"
    fi
  done < <(find "$PROCESSED_DIR" -name "*.json" -newer "$BRIDGE_STATE" 2>/dev/null | head -50)
fi
echo "$SCAN_NOW" > "$BRIDGE_STATE"
# Prune bridge dir entries older than 24h (main CC seb_boss reads + ACKs)
find "$BRIDGE_DIR" -name "*.md" -mmin +1440 -delete 2>/dev/null

# Trim log if >1000 lines
if [ -f "$LOG_FILE" ]; then
  LINES=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LINES" -gt 1000 ]; then
    tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

# Pull current state from cortextos bus
INBOX_RAW=$(cortextos bus check-inbox 2>&1 || echo "[]")
HEARTBEATS_RAW=$(cortextos bus read-all-heartbeats 2>&1 || echo "")

# Hash current state for diff
CURRENT_HASH=$(echo -n "${INBOX_RAW}${HEARTBEATS_RAW}" | sha256sum 2>/dev/null | cut -c1-16)

# Load previous state hash
PREV_HASH=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH=$(grep -oE '"hash":"[^"]+"' "$STATE_FILE" 2>/dev/null | cut -d'"' -f4 || echo "")
fi

# If unchanged → exit silently
if [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  exit 0
fi

# State changed — write new state
cat > "$STATE_FILE" <<EOF
{"hash":"$CURRENT_HASH","ts":"$NOW_UTC"}
EOF

# Scan for MAJOR events in heartbeats — patterns Sebastian cares about
MAJOR_EVENT=""

# Pattern 1: phase ship
if echo "$HEARTBEATS_RAW" | grep -qiE "shipped|phase.*complete|ship-gate.*pass"; then
  MAJOR_EVENT="phase ship detected"
fi

# Pattern 2: NO-GO verdict
if echo "$HEARTBEATS_RAW" | grep -qiE "NO-GO|verdict.*fail|review.*reject"; then
  MAJOR_EVENT="${MAJOR_EVENT:+$MAJOR_EVENT / }NO-GO verdict"
fi

# Pattern 3: crash / halt / capped
if echo "$HEARTBEATS_RAW" | grep -qiE "crashed|halted|context-capped|cap hit"; then
  MAJOR_EVENT="${MAJOR_EVENT:+$MAJOR_EVENT / }agent halt/cap"
fi

# Pattern 4: decision-needed / Sebastian-input-required
if echo "$HEARTBEATS_RAW" | grep -qiE "decision.needed|sebastian.input.required|approval.required"; then
  MAJOR_EVENT="${MAJOR_EVENT:+$MAJOR_EVENT / }decision-needed"
fi

# Pattern 5: new bus inbox message (priority>=normal)
if [ "$INBOX_RAW" != "[]" ] && [ -n "$INBOX_RAW" ]; then
  # Extract any messages flagged urgent/high
  if echo "$INBOX_RAW" | grep -qiE '"priority":"(urgent|high)"'; then
    MAJOR_EVENT="${MAJOR_EVENT:+$MAJOR_EVENT / }urgent inbox"
  fi
fi

# If MAJOR event detected → ping seb_boss via bus (THIS spawns LLM session, only when needed)
if [ -n "$MAJOR_EVENT" ]; then
  # Idempotency: dedup on event-content alone, with 1hr cooldown window
  EVENT_KEY=$(echo -n "$MAJOR_EVENT" | sha256sum | cut -c1-16)
  EVENT_HASH="$EVENT_KEY"
  # Check if this event-key appeared in last hour (last 12 lines = ~1hr at 5min cadence)
  if [ -f "$RELAYED_FILE" ]; then
    RECENT=$(tail -12 "$RELAYED_FILE" 2>/dev/null | grep -F "$EVENT_KEY" | head -1)
    if [ -n "$RECENT" ]; then
      echo "$NOW_UTC dedup_skip event=\"$MAJOR_EVENT\" key=$EVENT_KEY" >> "$LOG_FILE"
      exit 0
    fi
  fi
  # Relay via bus
  cortextos bus send-message seb_boss high "[surface-poll $NOW_UTC] MAJOR detected: $MAJOR_EVENT — investigate + Telegram Sebastian if appropriate. Inbox state at end of state-diff." 2>&1 | head -2 >> "$LOG_FILE"
  echo "{\"ts\":\"$NOW_UTC\",\"hash\":\"$EVENT_HASH\",\"event\":\"$MAJOR_EVENT\"}" >> "$RELAYED_FILE"
  echo "$NOW_UTC relayed event=$MAJOR_EVENT" >> "$LOG_FILE"
else
  echo "$NOW_UTC state_changed_but_no_major" >> "$LOG_FILE"
fi

exit 0
