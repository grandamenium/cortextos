#!/usr/bin/env bash
# see-diff.sh — Compare a reference image to a live screen capture, return structured diff JSON.
#
# Usage:
#   see-diff.sh --reference <ref.png> \
#               [--target <file.png> | --target-window <app-name> | --target-display <N>] \
#               [--model qwen2.5vl:7b] [--ollama-host <url>] \
#               [--out /tmp/diff.json]
#
# Output JSON schema:
#   {
#     "differences": [
#       {
#         "element": "<which UI element>",
#         "location": "<where on screen, e.g. top-left, bottom-center>",
#         "expected": "<what reference shows>",
#         "actual": "<what live shows>",
#         "severity": "high|medium|low",
#         "suggested_fix": "<concrete code or CSS-class suggestion>"
#       },
#       ...
#     ],
#     "summary": "<one-sentence overall verdict>"
#   }

set -uo pipefail

REF=""
TARGET_FILE=""
TARGET_WINDOW=""
TARGET_DISPLAY="1"
MODEL="${OLLAMA_VISION_MODEL:-qwen2.5vl:7b}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OUT_FILE="/tmp/eyes-diff-$$.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --reference)      REF="$2"; shift 2 ;;
    --target)         TARGET_FILE="$2"; shift 2 ;;
    --target-window)  TARGET_WINDOW="$2"; shift 2 ;;
    --target-display) TARGET_DISPLAY="$2"; shift 2 ;;
    --model)          MODEL="$2"; shift 2 ;;
    --ollama-host)    OLLAMA_HOST="$2"; shift 2 ;;
    --out)            OUT_FILE="$2"; shift 2 ;;
    -h|--help)        sed -n '2,20p' "$0" | sed 's/^# *//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REF" ] || [ ! -f "$REF" ]; then
  echo '{"verdict":"error","error":"--reference required and must exist"}' >&2
  exit 2
fi

# Get target screenshot
if [ -n "$TARGET_FILE" ]; then
  TARGET="$TARGET_FILE"
elif [ -n "$TARGET_WINDOW" ]; then
  TARGET="/tmp/eyes-target-$$.png"
  osascript -e "tell application \"$TARGET_WINDOW\" to activate" 2>/dev/null || true
  sleep 0.4
  /usr/sbin/screencapture -x -D "$TARGET_DISPLAY" -t png "$TARGET" 2>/dev/null
else
  TARGET="/tmp/eyes-target-$$.png"
  /usr/sbin/screencapture -x -D "$TARGET_DISPLAY" -t png "$TARGET" 2>/dev/null
fi

if [ ! -s "$TARGET" ]; then
  echo '{"verdict":"error","error":"target capture produced no output"}' >&2
  exit 3
fi

# Auto-downsample to 1280px width if larger — qwen2.5-vl:7b cold-encode time scales
# with image area; 3840x2160 inputs were taking >300s to first token. 1280px width
# is the sweet spot: ~45s for two-image diff, vs >300s on full-res.
downsample_if_large() {
  local src="$1" dst="$2"
  local w
  w=$(sips --getProperty pixelWidth "$src" 2>/dev/null | awk "/pixelWidth/{print \$2}")
  if [ -n "$w" ] && [ "$w" -gt 1280 ]; then
    sips --resampleWidth 1280 "$src" --out "$dst" >/dev/null 2>&1
    echo "downsampled $w → 1280px" >&2
  else
    cp "$src" "$dst"
  fi
}
REF_SMALL="/tmp/eyes-ref-$$.png"
TARGET_SMALL="/tmp/eyes-tgt-$$.png"
downsample_if_large "$REF" "$REF_SMALL"
downsample_if_large "$TARGET" "$TARGET_SMALL"
REF="$REF_SMALL"
TARGET="$TARGET_SMALL"

PROMPT='You are an expert frontend reviewer. Two images are attached: a REFERENCE design and a CURRENT live rendering. The CURRENT view should match the REFERENCE.

Identify every visible difference. For each difference output a JSON object with: element (which UI piece), location (top/center/bottom + left/center/right), expected (what reference shows), actual (what current shows), severity (high|medium|low), suggested_fix (one-sentence concrete suggestion — class name, value, position, color, etc.).

Output ONLY valid JSON with this exact schema (no prose, no markdown fences):
{"differences":[{"element":"...","location":"...","expected":"...","actual":"...","severity":"...","suggested_fix":"..."}],"summary":"<one sentence>"}

If there are no meaningful differences, return {"differences":[],"summary":"matches reference"}.'

# Send BOTH images to ollama via stdin payload file. Avoids shell-arg-length and
# quoting issues when base64 blobs are large.
PAYLOAD_FILE="/tmp/eyes-payload-$$.json"
python3 - "$REF" "$TARGET" "$MODEL" "$PROMPT" > "$PAYLOAD_FILE" <<'PYEOF'
import base64, json, sys
ref_path, tgt_path, model, prompt = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
ref = base64.b64encode(open(ref_path, 'rb').read()).decode('ascii')
tgt = base64.b64encode(open(tgt_path, 'rb').read()).decode('ascii')
print(json.dumps({
    'model': model,
    'prompt': f"{prompt}\n\nThe FIRST image is the REFERENCE. The SECOND image is the CURRENT live view.",
    'images': [ref, tgt],
    'stream': False,
    'format': 'json',
    'keep_alive': '20m',
    'options': {'num_predict': 2048, 'temperature': 0.15},
}))
PYEOF

T0=$(date +%s)
RESP=$(curl -s -m 600 -H "Content-Type: application/json" --data-binary "@$PAYLOAD_FILE" "$OLLAMA_HOST/api/generate" 2>/dev/null)
ELAPSED=$(($(date +%s) - T0))
rm -f "$PAYLOAD_FILE" "$REF_SMALL" "$TARGET_SMALL"

JSON_TEXT=$(printf '%s' "$RESP" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('response','').strip())" 2>/dev/null)

# Try to parse the response as JSON. If not, save it raw + error.
if printf '%s' "$JSON_TEXT" | python3 -c "import sys,json; json.loads(sys.stdin.read())" 2>/dev/null; then
  printf '%s\n' "$JSON_TEXT" > "$OUT_FILE"
  python3 -c "
import json
d = json.loads('''$JSON_TEXT''')
env = {
    'verdict': 'ok',
    'reference': '$REF',
    'target': '$TARGET',
    'model': '$MODEL',
    'elapsed_s': $ELAPSED,
    'diff_path': '$OUT_FILE',
    'diff_count': len(d.get('differences', [])),
    'summary': d.get('summary', ''),
}
print(json.dumps(env, indent=2))
"
else
  echo '{"verdict":"error","error":"vision model did not return parseable JSON","raw_response":'"$(printf '%s' "$JSON_TEXT" | head -c 500 | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"'}' >&2
  exit 4
fi
