#!/usr/bin/env bash
# screen-question.sh — Capture screen, send to qwen2.5-vl, get text answer.
#
# Usage:
#   screen-question.sh [--window <bundle-name-or-id>] [--display <N>] \
#                      [--model qwen2.5vl:7b] [--ollama-host <url>] \
#                      [--save-to /tmp/capture.png] [--out /tmp/answer.txt] \
#                      "<question text>"
#
# Defaults: full main display, qwen2.5vl:7b on 127.0.0.1:11434, capture to /tmp/eyes-screen-$$.png

set -uo pipefail

WINDOW=""
DISPLAY_ID="1"
MODEL="${OLLAMA_VISION_MODEL:-qwen2.5vl:7b}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
SAVE_TO="/tmp/eyes-screen-$$.png"
OUT_FILE=""
QUESTION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --window)      WINDOW="$2"; shift 2 ;;
    --display)     DISPLAY_ID="$2"; shift 2 ;;
    --model)       MODEL="$2"; shift 2 ;;
    --ollama-host) OLLAMA_HOST="$2"; shift 2 ;;
    --save-to)     SAVE_TO="$2"; shift 2 ;;
    --out)         OUT_FILE="$2"; shift 2 ;;
    -h|--help)     sed -n '2,9p' "$0" | sed 's/^# *//'; exit 0 ;;
    *)             QUESTION="${QUESTION}${QUESTION:+ }$1"; shift ;;
  esac
done

if [ -z "$QUESTION" ]; then
  echo "ERROR: question text required" >&2
  exit 2
fi

# Capture
if [ -n "$WINDOW" ]; then
  # screencapture window capture by window id requires `screencapture -l<id>`. We
  # don't know the id ahead of time; use AppleScript to focus then full-screen
  # capture, or fallback to interactive selection. For now: capture display.
  osascript -e "tell application \"$WINDOW\" to activate" 2>/dev/null || true
  sleep 0.4
fi
/usr/sbin/screencapture -x -D "$DISPLAY_ID" -t png "$SAVE_TO" 2>/dev/null
if [ ! -s "$SAVE_TO" ]; then
  echo '{"verdict":"error","error":"screencapture produced no output"}' >&2
  exit 3
fi

# Encode + POST to ollama
PAYLOAD=$(python3 -c "
import base64, json, sys
img = base64.b64encode(open('$SAVE_TO','rb').read()).decode('ascii')
print(json.dumps({
    'model': '$MODEL',
    'prompt': '''$QUESTION

Answer concisely. Use plain text, no markdown.''',
    'images': [img],
    'stream': False,
    'options': {'num_predict': 1024, 'temperature': 0.2},
}))
")

T0=$(date +%s)
RESP=$(curl -s -m 300 -H "Content-Type: application/json" --data-binary "$PAYLOAD" "$OLLAMA_HOST/api/generate" 2>/dev/null)
ELAPSED=$(($(date +%s) - T0))

ANSWER=$(printf '%s' "$RESP" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('response','').strip())" 2>/dev/null)

if [ -z "$ANSWER" ]; then
  echo '{"verdict":"error","error":"empty response","raw":'"$(printf '%s' "$RESP" | head -c 400 | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"'}' >&2
  exit 4
fi

[ -n "$OUT_FILE" ] && printf '%s\n' "$ANSWER" > "$OUT_FILE"

python3 -c "
import json
print(json.dumps({
    'verdict': 'ok',
    'screenshot': '$SAVE_TO',
    'model': '$MODEL',
    'elapsed_s': $ELAPSED,
    'answer': '''$ANSWER''',
}, indent=2))
"
