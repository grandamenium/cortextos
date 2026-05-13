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

# Cleanup on exit — temp payload/response files always go.
TMP_FILES=()
cleanup() { for f in "${TMP_FILES[@]:-}"; do [ -n "$f" ] && rm -f "$f"; done; }
trap cleanup EXIT

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

# Validate --display is a small integer.
if ! [[ "$DISPLAY_ID" =~ ^[0-9]{1,3}$ ]]; then
  echo '{"verdict":"error","error":"--display must be a small integer"}' >&2
  exit 2
fi

# Validate --window against AppleScript injection.
if [ -n "$WINDOW" ] && ! [[ "$WINDOW" =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]]; then
  echo '{"verdict":"error","error":"--window contains unsupported characters (allowed: A-Z a-z 0-9 space . _ -)"}' >&2
  exit 2
fi

# Capture
if [ -n "$WINDOW" ]; then
  /usr/bin/osascript -e "tell application \"$WINDOW\" to activate" 2>/dev/null || true
  sleep 0.4
fi
/usr/sbin/screencapture -x -D "$DISPLAY_ID" -t png "$SAVE_TO" 2>/dev/null
if [ ! -s "$SAVE_TO" ]; then
  echo '{"verdict":"error","error":"screencapture produced no output"}' >&2
  exit 3
fi

# Build the payload in Python with argv-only inputs (no shell-string interpolation
# of $QUESTION, image bytes, or model output). Writes payload to a file; curl
# reads it via @file; model response is parsed via stdin/file in the next python
# block — model output never reaches a `python -c` triple-string.
PAYLOAD_FILE="/tmp/eyes-sq-payload-$$.json"; TMP_FILES+=("$PAYLOAD_FILE")
python3 - "$SAVE_TO" "$MODEL" "$QUESTION" "$PAYLOAD_FILE" <<'PYEOF'
import base64, json, sys
img_path, model, question, out_path = sys.argv[1:5]
img = base64.b64encode(open(img_path, 'rb').read()).decode('ascii')
with open(out_path, 'w') as f:
    json.dump({
        'model': model,
        'prompt': f"{question}\n\nAnswer concisely. Use plain text, no markdown.",
        'images': [img],
        'stream': False,
        'keep_alive': '20m',
        'options': {'num_predict': 1024, 'temperature': 0.2},
    }, f)
PYEOF

T0=$(date +%s)
RESP_FILE="/tmp/eyes-sq-resp-$$.json"; TMP_FILES+=("$RESP_FILE")
curl -s -m 300 -H "Content-Type: application/json" --data-binary "@$PAYLOAD_FILE" -o "$RESP_FILE" "$OLLAMA_HOST/api/generate" 2>/dev/null
ELAPSED=$(($(date +%s) - T0))

# Parse the response in a python block driven by stdin/argv (never interpolate
# model output into a shell variable + python -c).
python3 - "$RESP_FILE" "$SAVE_TO" "$MODEL" "$ELAPSED" "${OUT_FILE:-}" <<'PYEOF'
import json, sys
resp_path, screenshot, model, elapsed, out_file = sys.argv[1:6]
elapsed = int(elapsed)
try:
    with open(resp_path) as f:
        body = json.load(f)
    answer = (body.get('response') or '').strip()
except (json.JSONDecodeError, FileNotFoundError) as e:
    err = {'verdict': 'error', 'error': f'ollama call failed: {type(e).__name__}: {e}', 'elapsed_s': elapsed}
    print(json.dumps(err, indent=2), file=sys.stderr)
    sys.exit(4)

if not answer:
    err = {'verdict': 'error', 'error': 'empty response from vision model', 'elapsed_s': elapsed}
    print(json.dumps(err, indent=2), file=sys.stderr)
    sys.exit(4)

if out_file:
    with open(out_file, 'w') as f:
        f.write(answer + '\n')

env = {
    'verdict': 'ok',
    'screenshot': screenshot,
    'model': model,
    'elapsed_s': elapsed,
    'answer': answer,
}
print(json.dumps(env, indent=2))
PYEOF
