#!/usr/bin/env bash
# send-sms.sh — Send an SMS via Twilio REST API
# Usage: send-sms.sh <to-number> <message>
# Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in agent .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh"
ctx_source_env

TO="${1:?Usage: send-sms.sh <to-number> <message>}"
MESSAGE="${2:?Usage: send-sms.sh <to-number> <message>}"

if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" || -z "${TWILIO_PHONE_NUMBER:-}" ]]; then
    echo "Error: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER must be set in .env" >&2
    exit 1
fi

RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json" \
    -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
    --data-urlencode "To=${TO}" \
    --data-urlencode "From=${TWILIO_PHONE_NUMBER}" \
    --data-urlencode "Body=${MESSAGE}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
    SID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sid',''))" 2>/dev/null || echo "")
    echo "SMS sent to ${TO} (sid: ${SID})"
else
    echo "Error sending SMS (HTTP ${HTTP_CODE}):" >&2
    echo "$BODY" >&2
    exit 1
fi
