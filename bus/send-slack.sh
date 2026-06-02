#!/usr/bin/env bash
# send-slack.sh — post to a Slack channel under an agent's identity.
# Usage:
#   bus/send-slack.sh <agent> <channel> "<text>"
# Reads slack.json from orgs/<org>/agents/<agent>/slack.json (or namespaced).
# Requires SLACK_BOT_TOKEN in env.

set -euo pipefail

AGENT="${1:?usage: send-slack.sh <agent> <channel> <text>}"
CHANNEL="${2:?usage: send-slack.sh <agent> <channel> <text>}"
TEXT="${3:?usage: send-slack.sh <agent> <channel> <text>}"

# Delegate to the CLI for identity resolution + posting — keeps the JSON
# lookup in one place (TypeScript) instead of duplicating in bash.
exec node "${CTX_FRAMEWORK_ROOT:-/opt/cortextos}/dist/cli.js" slack test-send \
    "$CHANNEL" "$TEXT" --as "$AGENT"
