#!/usr/bin/env bash
# send-voice.sh — Send a Telegram voice message via ElevenLabs TTS
# Usage: send-voice.sh <chat_id> <text> [--voice <voice_id>]
# Requires ELEVENLABS_API_KEY and BOT_TOKEN in agent .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh"
ctx_source_env
source "${SCRIPT_DIR}/_telegram-curl.sh"

CHAT_ID="${1:?Usage: send-voice.sh <chat_id> <text> [--voice <voice_id>]}"
TEXT="${2:?Usage: send-voice.sh <chat_id> <text> [--voice <voice_id>]}"

DEFAULT_VOICE="${ELEVENLABS_VOICE_ID:-lUTamkMw7gOzZbFIwmq4}"
VOICE_ID="$DEFAULT_VOICE"

shift 2
while [[ $# -gt 0 ]]; do
    case "$1" in
        --voice) VOICE_ID="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
    echo "Error: ELEVENLABS_API_KEY must be set in .env" >&2
    exit 1
fi

TMPDIR="${TMPDIR:-/tmp}"
MP3_FILE="${TMPDIR}/cortextos-voice-$$.mp3"
OGG_FILE="${TMPDIR}/cortextos-voice-$$.ogg"
trap 'rm -f "$MP3_FILE" "$OGG_FILE"' EXIT

# Phonetic replacements for correct pronunciation
TEXT=$(echo "$TEXT" | sed 's/Samer/Sammer/g; s/samer/sammer/g')

ESCAPED_TEXT=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$TEXT")

HTTP_CODE=$(curl -s -w "%{http_code}" -o "$MP3_FILE" \
    -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
    -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"text\":${ESCAPED_TEXT},\"model_id\":\"eleven_v3\",\"voice_settings\":{\"stability\":0.5,\"similarity_boost\":0.75}}")

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
    echo "ElevenLabs API error (HTTP ${HTTP_CODE})" >&2
    cat "$MP3_FILE" >&2
    exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
    echo "Error: ffmpeg is required for voice conversion" >&2
    exit 1
fi

ffmpeg -i "$MP3_FILE" -acodec libopus -ac 1 -ar 48000 "$OGG_FILE" -y 2>/dev/null

RESPONSE=$(telegram_api_post "sendVoice" \
    -F "chat_id=${CHAT_ID}" \
    -F "voice=@${OGG_FILE}")

OK=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")

if [[ "$OK" == "True" ]]; then
    echo "Voice message sent to ${CHAT_ID}"
else
    echo "Error sending voice message:" >&2
    echo "$RESPONSE" >&2
    exit 1
fi
