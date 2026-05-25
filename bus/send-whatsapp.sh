#!/usr/bin/env bash
# send-whatsapp.sh — Send a WhatsApp message via Twilio REST API
# Usage: send-whatsapp.sh <to-number> <message>
# The to-number should be in E.164 format (e.g., +14155551234) — the whatsapp: prefix is added automatically.
# Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER in agent .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh"
ctx_source_env

TO="${1:?Usage: send-whatsapp.sh <to-number> <message>}"
MESSAGE="${2:?Usage: send-whatsapp.sh <to-number> <message>}"

if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" || -z "${TWILIO_WHATSAPP_NUMBER:-}" ]]; then
    echo "Error: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER must be set in .env" >&2
    exit 1
fi

RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json" \
    -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
    --data-urlencode "To=whatsapp:${TO}" \
    --data-urlencode "From=whatsapp:${TWILIO_WHATSAPP_NUMBER}" \
    --data-urlencode "Body=${MESSAGE}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
    SID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sid',''))" 2>/dev/null || echo "")
    echo "WhatsApp sent to ${TO} (sid: ${SID})"
else
    echo "Error sending WhatsApp (HTTP ${HTTP_CODE}):" >&2
    echo "$BODY" >&2
    exit 1
fi
