#!/usr/bin/env bash
# rpc.sh — synchronous request-reply over the cortextos bus.
# Send → poll caller inbox for reply with matching reply_to → ack → return JSON.

set -uo pipefail

TARGET=""
QUERY=""
TIMEOUT=120
PRIORITY="high"
FROM="${CTX_AGENT_NAME:-$(basename "$(pwd)" 2>/dev/null || echo dev)}"

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    --from)     FROM="$2"; shift 2 ;;
    -h|--help)  sed -n '2,4p' "$0" | sed 's/^# *//'; exit 0 ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"
      elif [ -z "$QUERY" ]; then QUERY="$1"
      else QUERY="$QUERY $1"; fi
      shift ;;
  esac
done

if [ -z "$TARGET" ] || [ -z "$QUERY" ]; then
  echo '{"verdict":"error","error":"usage: rpc.sh <target-agent> \"<query>\" [--timeout N] [--priority P] [--from CALLER]"}' >&2
  exit 2
fi

# Find caller inbox directory
CTX_ROOT="${CTX_ROOT:-/Users/subbu_ai_assistant/.cortextos/default}"
INBOX="$CTX_ROOT/inbox/$FROM"
if [ ! -d "$INBOX" ]; then
  echo "{\"verdict\":\"error\",\"error\":\"caller inbox does not exist at $INBOX — set --from correctly\"}" >&2
  exit 3
fi

# Stage 1: send the message
T0=$(date +%s)
SEND_OUT=$(cortextos bus send-message "$TARGET" "$PRIORITY" "$QUERY" 2>&1 | tail -1)
RC=$?

if [ $RC -ne 0 ] || [ -z "$SEND_OUT" ]; then
  python3 -c "
import json
print(json.dumps({
    'verdict': 'error',
    'error': 'cortextos bus send-message failed',
    'rc': $RC,
    'stdout_tail': '''$SEND_OUT''',
}, indent=2))
"
  exit 4
fi

# msg_id is the last line — strip whitespace
MSG_ID=$(echo "$SEND_OUT" | tr -d '[:space:]')

# Stage 2: poll for reply
DEADLINE=$(($(date +%s) + TIMEOUT))
REPLY_FILE=""
while [ $(date +%s) -lt $DEADLINE ]; do
  for f in "$INBOX"/*.json; do
    [ -f "$f" ] || continue
    # JSON-parse each candidate; match on reply_to
    if python3 -c "
import json, sys
try:
    d = json.load(open('$f'))
    sys.exit(0 if d.get('reply_to') == '$MSG_ID' else 1)
except Exception: sys.exit(2)
"; then
      REPLY_FILE="$f"
      break 2
    fi
  done
  sleep 2
done

ELAPSED=$(($(date +%s) - T0))

if [ -z "$REPLY_FILE" ]; then
  python3 -c "
import json
print(json.dumps({
    'verdict': 'timeout',
    'target': '$TARGET',
    'sent_msg_id': '$MSG_ID',
    'elapsed_s': $ELAPSED,
    'note': 'no reply within ${TIMEOUT}s; target may still reply later — caller can re-poll',
}, indent=2))
"
  exit 0
fi

# Stage 3: parse reply, ack it
python3 - "$REPLY_FILE" "$MSG_ID" "$TARGET" "$ELAPSED" <<'PYEOF'
import json, sys, subprocess
reply_path, sent_id, target, elapsed = sys.argv[1:5]
elapsed = int(elapsed)
try:
    d = json.load(open(reply_path))
except Exception as e:
    print(json.dumps({"verdict": "error", "error": f"failed to parse reply file: {e}"}), file=sys.stderr)
    sys.exit(5)

reply_id = d.get("id", "")
# ACK the reply
if reply_id:
    subprocess.run(["cortextos", "bus", "ack-inbox", reply_id], capture_output=True, timeout=10)

env = {
    "verdict": "ok",
    "target": target,
    "sent_msg_id": sent_id,
    "elapsed_s": elapsed,
    "reply": {
        "id": d.get("id"),
        "from": d.get("from"),
        "reply_to": d.get("reply_to"),
        "text": d.get("text", ""),
    },
}
print(json.dumps(env, indent=2))
PYEOF
