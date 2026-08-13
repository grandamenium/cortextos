#!/usr/bin/env bash
# send-buzz.sh — wrapper for Node.js CLI
# Usage: send-buzz.sh <channel-uuid> <message> [--reply-to <event-id>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

CHANNEL="${1:?Usage: send-buzz.sh <channel-uuid> <message> [--reply-to <event-id>]}"
MESSAGE="${2:?Usage: send-buzz.sh <channel-uuid> <message> [--reply-to <event-id>]}"
shift 2

exec node "$CLI" buzz send --channel "$CHANNEL" --text "$MESSAGE" "$@"
