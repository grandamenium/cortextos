#!/usr/bin/env bash
# send-message.sh — wrapper for Node.js CLI
# Usage: send-message.sh <to> <priority> [text] [reply_to_id] [--body-stdin|--body-file <path>] [--reply-to <id>]
#
# Security: prefer --body-stdin (or --body-file) for any body containing code,
# backticks, or $() — those forms read the body without interpolating it into a
# shell-expanded argument. A body passed positionally is subject to the CALLER's
# shell expansion before this script runs (root of the 2026-06-02 incident).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

# Separate flags from positionals so --body-stdin/--body-file/--reply-to pass through.
POSITIONAL=()
FLAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --body-stdin) FLAGS+=("$1"); shift ;;
    --body-file|--reply-to) FLAGS+=("$1" "${2:-}"); shift 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

TO="${POSITIONAL[0]:-}"
PRIORITY="${POSITIONAL[1]:-normal}"
TEXT="${POSITIONAL[2]:-}"
REPLY_TO="${POSITIONAL[3]:-}"

# Body may come from --body-stdin/--body-file instead of positional TEXT.
HAS_BODY_FLAG=0
for f in "${FLAGS[@]:-}"; do
  [[ "$f" == "--body-stdin" || "$f" == "--body-file" ]] && HAS_BODY_FLAG=1
done

if [[ -z "$TO" ]] || { [[ -z "$TEXT" ]] && [[ "$HAS_BODY_FLAG" -eq 0 ]]; }; then
  echo "Usage: send-message.sh <to> <priority> [text] [reply_to] [--body-stdin|--body-file <path>]" >&2
  exit 1
fi

ARGS=("$TO" "$PRIORITY")
[[ -n "$TEXT" ]] && ARGS+=("$TEXT")
[[ -n "$REPLY_TO" ]] && ARGS+=(--reply-to "$REPLY_TO")
[[ ${#FLAGS[@]} -gt 0 ]] && ARGS+=("${FLAGS[@]}")

exec node "$CLI" bus send-message "${ARGS[@]}"
