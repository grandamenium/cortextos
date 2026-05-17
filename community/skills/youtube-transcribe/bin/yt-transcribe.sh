#!/usr/bin/env bash
# yt-transcribe.sh — YouTube → audio → Whisper transcript (local).
#
# Usage: yt-transcribe.sh <url-or-id> [--out path.md] [--model base.en]
set -uo pipefail

YTDLP=/opt/homebrew/bin/yt-dlp
MODEL="base.en"
OUT=""
URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out)   OUT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# *//'; exit 0 ;;
    *) URL="$1"; shift ;;
  esac
done

if [ -z "$URL" ]; then
  echo '{"verdict":"error","error":"url-or-id required"}' >&2; exit 2
fi
if [ ! -x "$YTDLP" ]; then
  echo '{"verdict":"error","error":"yt-dlp not installed at '"$YTDLP"' — brew install yt-dlp"}' >&2; exit 3
fi

# Allow plain video IDs (11-char alphanum)
if [[ "$URL" =~ ^[A-Za-z0-9_-]{11}$ ]]; then
  URL="https://www.youtube.com/watch?v=$URL"
fi

WORK=$(mktemp -d -t yt-transcribe)
trap "rm -rf '$WORK'" EXIT

echo "[1/3] fetching audio..." >&2
# Download in native container (m4a/webm) — no ffmpeg postprocess required.
# Both faster_whisper and mlx_whisper handle m4a/webm via PyAV bindings.
# Prefer m4a (audio/mp4) which has broader codec compat than webm/opus.
"$YTDLP" -f 'bestaudio[ext=m4a]/bestaudio/best' \
  -o "$WORK/audio.%(ext)s" \
  --no-playlist --quiet --no-warnings \
  --print-json "$URL" > "$WORK/meta.json" 2>"$WORK/yt.err" || {
    echo "{\"verdict\":\"error\",\"error\":\"yt-dlp failed\",\"stderr\":\"$(head -c 500 < "$WORK/yt.err" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" )\"}" >&2
    exit 4
  }

# yt-dlp wrote with the actual extension; find it.
AUDIO=$(ls "$WORK"/audio.* 2>/dev/null | head -1)
[ -f "$AUDIO" ] || { echo '{"verdict":"error","error":"audio download produced no file"}' >&2; exit 5; }

VIDEO_ID=$(python3 -c "import json,sys; print(json.load(open('$WORK/meta.json')).get('id','unknown'))")
TITLE=$(python3 -c "import json,sys; print(json.load(open('$WORK/meta.json')).get('title','')[:200])")
DURATION=$(python3 -c "import json,sys; print(json.load(open('$WORK/meta.json')).get('duration',0))")

[ -z "$OUT" ] && OUT="/tmp/yt-transcribe-${VIDEO_ID}.md"

echo "[2/3] transcribing ($MODEL, ~${DURATION}s audio)..." >&2

# Try mlx-whisper first (M-series GPU, fastest on MacBook), fall back to whisper-cpu, fall back to openai-whisper.
for venv_python in \
    /Users/hari/voice-py312/bin/python \
    /Users/subbu_ai_assistant/voice-pipeline/venv/bin/python \
    /usr/bin/python3; do
  [ -x "$venv_python" ] || continue
  if "$venv_python" -c "import mlx_whisper" 2>/dev/null; then
    "$venv_python" - <<PY > "$WORK/transcript.json"
import json, mlx_whisper
res = mlx_whisper.transcribe("$AUDIO", path_or_hf_repo="mlx-community/whisper-${MODEL//[.\-]/-}", verbose=False)
print(json.dumps(res))
PY
    backend="mlx-whisper"
    break
  fi
  if "$venv_python" -c "from faster_whisper import WhisperModel" 2>/dev/null; then
    "$venv_python" - <<PY > "$WORK/transcript.json"
import json
from faster_whisper import WhisperModel
m = WhisperModel("$MODEL", device="auto", compute_type="default")
segs, info = m.transcribe("$AUDIO", beam_size=1)
segs = list(segs)
print(json.dumps({"segments": [{"start":s.start,"end":s.end,"text":s.text} for s in segs], "language": info.language, "duration": info.duration}))
PY
    backend="faster-whisper"
    break
  fi
done

if [ ! -s "$WORK/transcript.json" ]; then
  echo '{"verdict":"error","error":"no whisper backend available — install mlx-whisper or faster-whisper into a venv"}' >&2
  exit 6
fi

echo "[3/3] writing markdown to $OUT..." >&2

python3 - "$WORK/transcript.json" "$OUT" "$URL" "$VIDEO_ID" "$TITLE" "$DURATION" "$MODEL" "${backend:-unknown}" <<'PYEOF'
import json, sys, datetime
trn_path, out_path, url, vid, title, duration, model, backend = sys.argv[1:9]
trn = json.load(open(trn_path))
segs = trn.get("segments", [])

def fmt_t(s):
    s = int(s)
    return f"{s//3600:02d}:{(s//60)%60:02d}:{s%60:02d}"

with open(out_path, "w") as f:
    f.write("---\n")
    f.write(f"source: {url}\n")
    f.write(f"video_id: {vid}\n")
    f.write(f"title: {title}\n")
    f.write(f"duration_s: {duration}\n")
    f.write(f"model: {model}\n")
    f.write(f"backend: {backend}\n")
    f.write(f"language: {trn.get('language', 'en')}\n")
    f.write(f"transcribed_at: {datetime.datetime.utcnow().isoformat()}Z\n")
    f.write("---\n\n")
    for s in segs:
        f.write(f"[{fmt_t(s['start'])}] {s['text'].strip()}\n")

import os
print(json.dumps({
    "verdict": "ok",
    "url": url,
    "video_id": vid,
    "title": title,
    "duration_s": duration,
    "model": model,
    "backend": backend,
    "out_path": out_path,
    "segments": len(segs),
    "out_bytes": os.path.getsize(out_path),
}, indent=2))
PYEOF
