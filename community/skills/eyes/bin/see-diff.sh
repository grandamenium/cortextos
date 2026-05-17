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

# Cleanup on exit — drop temp files on any path out.
TMP_FILES=()
cleanup() { for f in "${TMP_FILES[@]:-}"; do [ -n "$f" ] && rm -f "$f"; done; }
trap cleanup EXIT

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

# Validate --target-display is a small integer (passed to screencapture -D).
if ! [[ "$TARGET_DISPLAY" =~ ^[0-9]{1,3}$ ]]; then
  echo '{"verdict":"error","error":"--target-display must be a small integer"}' >&2
  exit 2
fi

# Validate --target-window against AppleScript injection — allow only safe chars.
# osascript -e "tell application \"$NAME\"..." is the injection sink; restrict NAME
# to alphanumerics + space + dot + dash + underscore.
if [ -n "$TARGET_WINDOW" ] && ! [[ "$TARGET_WINDOW" =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]]; then
  echo '{"verdict":"error","error":"--target-window contains unsupported characters (allowed: A-Z a-z 0-9 space . _ -)"}' >&2
  exit 2
fi

# F1+F2 hardening (post security-vp review of b5d704f).
# F1: SSRF allow-list on --ollama-host; loopback-only unless
#     EYES_ALLOW_REMOTE_OLLAMA=1 in env.
# F2: workspace-scope --reference and --target paths (realpath + prefix
#     check against /tmp, /private/tmp, $EYES_WORKSPACE, cwd).
. "$(dirname "$0")/_validate.sh"
__validate_ollama_host "$OLLAMA_HOST" || exit 5
__validate_workspace_path "--reference" "$REF" || exit 6
[ -n "$TARGET_FILE" ] && { __validate_workspace_path "--target" "$TARGET_FILE" || exit 6; }

# Get target screenshot
if [ -n "$TARGET_FILE" ]; then
  TARGET="$TARGET_FILE"
elif [ -n "$TARGET_WINDOW" ]; then
  TARGET="/tmp/eyes-target-$$.png"; TMP_FILES+=("$TARGET")
  /usr/bin/osascript -e "tell application \"$TARGET_WINDOW\" to activate" 2>/dev/null || true
  sleep 0.4
  /usr/sbin/screencapture -x -D "$TARGET_DISPLAY" -t png "$TARGET" 2>/dev/null
else
  TARGET="/tmp/eyes-target-$$.png"; TMP_FILES+=("$TARGET")
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
REF_SMALL="/tmp/eyes-ref-$$.png"; TMP_FILES+=("$REF_SMALL")
TARGET_SMALL="/tmp/eyes-tgt-$$.png"; TMP_FILES+=("$TARGET_SMALL")
downsample_if_large "$REF" "$REF_SMALL"
downsample_if_large "$TARGET" "$TARGET_SMALL"

PROMPT='You are an expert frontend reviewer. Two images are attached: a REFERENCE design and a CURRENT live rendering. The CURRENT view should match the REFERENCE.

Identify every visible difference. For each difference output a JSON object with: element (which UI piece), location (top/center/bottom + left/center/right), expected (what reference shows), actual (what current shows), severity (high|medium|low), suggested_fix (one-sentence concrete suggestion — class name, value, position, color, etc.).

Output ONLY valid JSON with this exact schema (no prose, no markdown fences):
{"differences":[{"element":"...","location":"...","expected":"...","actual":"...","severity":"...","suggested_fix":"..."}],"summary":"<one sentence>"}

If there are no meaningful differences, return {"differences":[],"summary":"matches reference"}.'

# Build payload + drive everything via stdin to avoid shell-quoting & python-eval
# injection: untrusted/large values (image bytes, model output) NEVER hit a shell
# string or a python `-c` interpolation; argv carries only validated args.
PAYLOAD_FILE="/tmp/eyes-payload-$$.json"; TMP_FILES+=("$PAYLOAD_FILE")
python3 - "$REF_SMALL" "$TARGET_SMALL" "$MODEL" "$PROMPT" "$PAYLOAD_FILE" <<'PYEOF'
import base64, json, sys
ref_path, tgt_path, model, prompt, out_path = sys.argv[1:6]
ref = base64.b64encode(open(ref_path, 'rb').read()).decode('ascii')
tgt = base64.b64encode(open(tgt_path, 'rb').read()).decode('ascii')
with open(out_path, 'w') as f:
    json.dump({
        'model': model,
        'prompt': f"{prompt}\n\nThe FIRST image is the REFERENCE. The SECOND image is the CURRENT live view.",
        'images': [ref, tgt],
        'stream': False,
        'format': 'json',
        'keep_alive': '20m',
        'options': {'num_predict': 2048, 'temperature': 0.15},
    }, f)
PYEOF

T0=$(date +%s)
RESP_FILE="/tmp/eyes-resp-$$.json"; TMP_FILES+=("$RESP_FILE")
curl -s -m 600 -H "Content-Type: application/json" --data-binary "@$PAYLOAD_FILE" -o "$RESP_FILE" "$OLLAMA_HOST/api/generate" 2>/dev/null
ELAPSED=$(($(date +%s) - T0))

# Parse the response entirely in Python via stdin — never interpolate raw model
# output into shell or `python -c`. Also writes the validated diff JSON to OUT_FILE
# and emits the envelope.
python3 - "$RESP_FILE" "$OUT_FILE" "$REF" "$TARGET" "$MODEL" "$ELAPSED" <<'PYEOF'
import json, sys
resp_path, out_path, ref, target, model, elapsed = sys.argv[1:7]
elapsed = int(elapsed)

try:
    with open(resp_path) as f:
        body = json.load(f)
    text = (body.get('response') or '').strip()
    parsed = json.loads(text)  # validate diff JSON
    with open(out_path, 'w') as f:
        json.dump(parsed, f, indent=2)
    env = {
        'verdict': 'ok',
        'reference': ref,
        'target': target,
        'model': model,
        'elapsed_s': elapsed,
        'diff_path': out_path,
        'diff_count': len(parsed.get('differences', [])),
        'summary': parsed.get('summary', ''),
    }
    print(json.dumps(env, indent=2))
except (json.JSONDecodeError, FileNotFoundError, KeyError) as e:
    err = {
        'verdict': 'error',
        'error': f'vision model did not return parseable JSON: {type(e).__name__}: {e}',
        'elapsed_s': elapsed,
    }
    print(json.dumps(err, indent=2), file=sys.stderr)
    sys.exit(4)
PYEOF
