#!/usr/bin/env bash
# install-whisper-model.sh — download the whisper.cpp GGML model used for
# Telegram voice transcription. Idempotent. Skips the download if the model
# already exists at the target path.
#
# Default model: ggml-tiny.en.bin (~75 MB). Override by setting WHISPER_MODEL
# (e.g. ggml-base.en.bin for higher accuracy at ~140 MB) and WHISPER_MODEL_DIR.
#
# This script is intentionally separate from npm install so the bundle stays
# slim. Run it once during onboarding; re-run only to upgrade the model.

set -euo pipefail

WHISPER_MODEL="${WHISPER_MODEL:-ggml-tiny.en.bin}"
WHISPER_MODEL_DIR="${WHISPER_MODEL_DIR:-${HOME}/.cortextos/models}"
URL_BASE="${WHISPER_MODEL_URL_BASE:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"

target="${WHISPER_MODEL_DIR}/${WHISPER_MODEL}"

if [ -f "$target" ]; then
  echo "[install-whisper-model] already present: $target"
  exit 0
fi

if ! command -v whisper-cli >/dev/null 2>&1; then
  echo "[install-whisper-model] WARN: whisper-cli not on PATH. Install with 'brew install whisper-cpp' (macOS) before running this script."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[install-whisper-model] WARN: ffmpeg not on PATH. Install with 'brew install ffmpeg' (macOS) before running this script."
fi

mkdir -p "$WHISPER_MODEL_DIR"

url="${URL_BASE}/${WHISPER_MODEL}"
echo "[install-whisper-model] downloading $WHISPER_MODEL → $target"
echo "[install-whisper-model] source: $url"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --connect-timeout 30 -o "${target}.partial" "$url"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${target}.partial" "$url"
else
  echo "[install-whisper-model] ERROR: neither curl nor wget available." >&2
  exit 1
fi

mv "${target}.partial" "$target"
size_mb=$(du -m "$target" | awk '{print $1}')
echo "[install-whisper-model] OK ${size_mb}M at $target"
