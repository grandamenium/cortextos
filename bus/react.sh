#!/usr/bin/env bash
# react.sh — wrapper for the connector-agnostic outbound-reaction CLI.
# Usage: react.sh <message_id> <emoji> [--remove] [--big]
#
# PR4 c24 of the pluggable-connectors stack. Reacts to an inbound
# message using the agent's active connector (Telegram setMessageReaction,
# future Discord/Mattermost/RocketChat/Matrix reaction APIs).
#
# Preferred over `send-telegram` for short acknowledgements per spec §11
# emoji-ack UX. Portable vocabulary:
#   👀 seen / ✅ done / ❌ failed / 👍 ack / 🛠 working / ⏸ paused / 🤔 ambiguous
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus react "$@"
