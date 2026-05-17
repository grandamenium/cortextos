#!/usr/bin/env bash
# screenshot-to-code.sh — Mode B of ui-generation skill
#
# Sends a screenshot to abi/screenshot-to-code Docker REST endpoint, captures
# generated TSX, returns structured envelope.
#
# Usage:
#   screenshot-to-code.sh --screenshot /path/to/png [--stack react-tailwind]
# Env:
#   ANTHROPIC_API_KEY (required by the abi/sc2c backend; usually in cortextos secrets.env)
#   SC2C_ENDPOINT (default http://localhost:7001)
#
# Output: JSON envelope on stdout, full TSX at /tmp/ui-generation/sc2c-<id>/page.tsx

set -uo pipefail

SCREENSHOT=""
STACK="react-tailwind"
ENDPOINT="${SC2C_ENDPOINT:-http://localhost:7001}"

while [ $# -gt 0 ]; do
  case "$1" in
    --screenshot) SCREENSHOT="$2"; shift 2 ;;
    --stack)      STACK="$2";      shift 2 ;;
    --endpoint)   ENDPOINT="$2";   shift 2 ;;
    *) echo '{"verdict":"error","error":"unknown arg '"$1"'"}' >&2; exit 2 ;;
  esac
done

if [ -z "$SCREENSHOT" ] || [ ! -f "$SCREENSHOT" ]; then
  echo '{"verdict":"error","error":"--screenshot required and must exist"}' >&2
  exit 2
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo '{"verdict":"error","error":"ANTHROPIC_API_KEY env var required (sc2c backend needs it)"}' >&2
  exit 3
fi

# Health-check the backend with a short timeout. Docker compose up takes ~15-30s
# on cold start; we wait up to 30s.
START=$(date +%s)
until curl -fsS --max-time 1 "$ENDPOINT/health" > /dev/null 2>&1; do
  if [ $(($(date +%s) - START)) -gt 30 ]; then
    echo '{"verdict":"error","error":"sc2c backend not reachable at '"$ENDPOINT"'/health — is `docker compose up -d` running in /Users/subbu_ai_assistant/cortextos-tools/screenshot-to-code?"}' >&2
    exit 4
  fi
  sleep 1
done

TASK_ID="sc2c-$(date +%s)-$$"
TASK_DIR="/tmp/ui-generation/${TASK_ID}"
mkdir -p "$TASK_DIR"

# Base64-encode the screenshot for transport
B64=$(base64 < "$SCREENSHOT" | tr -d '\n')

# Call sc2c backend's generate endpoint (the abi/sc2c API uses WebSocket
# streaming for code generation; here we do a simpler REST-style POST if the
# backend exposes /api/generate, else we fall back to driving via curl+ws).
T0=$(date +%s)
RESPONSE=$(curl -s -X POST "$ENDPOINT/api/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
  -d "{\"image\":\"data:image/png;base64,$B64\",\"stack\":\"$STACK\"}" 2>"${TASK_DIR}/curl.err")

ELAPSED=$(($(date +%s) - T0))

# Parse response. abi/sc2c returns JSON with `code` field.
CODE=$(printf '%s' "$RESPONSE" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('code', ''))
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$CODE" ]; then
  echo "{\"verdict\":\"error\",\"error\":\"empty code response from sc2c backend\",\"raw_response\":$(printf '%s' "$RESPONSE" | head -c 500 | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" >&2
  exit 5
fi

OUT_FILE="${TASK_DIR}/page.tsx"
printf '%s\n' "$CODE" > "$OUT_FILE"

CODE_LEN=$(wc -c < "$OUT_FILE" | tr -d ' ')

python3 -c "
import json
env = {
  'provider': 'screenshot-to-code',
  'task_id': '$TASK_ID',
  'elapsed_s': $ELAPSED,
  'stack': '$STACK',
  'output_path': '$OUT_FILE',
  'output_bytes': $CODE_LEN,
  'verdict': 'ok'
}
print(json.dumps(env, indent=2))
"
