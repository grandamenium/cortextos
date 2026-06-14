#!/bin/bash
# feature-overview-push.sh — push the PhytoMedic "Projekt-Puls" to Telegram.
#
# Pure CLI, NO LLM / NO agent turn / NO quota: runs
# `cortextos bus overview --format telegram` and `cortextos bus send-telegram`.
# Designed to run from the user's crontab 2x/day (morning + evening).
#
# IMPORTANT: the live daemon (and the agent .env with BOT_TOKEN) lives in the
# objective-mclaren worktree, not the main checkout. CTX_FRAMEWORK_ROOT must
# point there so send-telegram finds the bot token. Override via env if needed.
#
# Tunables (env):
#   CTX_ROOT               cortextos state root      (default: $HOME/.cortextos/default)
#   CTX_FRAMEWORK_ROOT     framework root w/ orgs/   (default: the objective-mclaren worktree)
#   CTX_ORG                org for bus calls         (default: phytomedic)
#   OVERVIEW_PUSH_AGENT    agent identity for send   (default: user-proxy)
#   OVERVIEW_PUSH_CHAT_ID  Telegram chat id          (default: 353207237)
#
# Exit 0 always (cron-friendly). Skips silently if the overview is empty.
set -uo pipefail

CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos/.claude/worktrees/objective-mclaren}"
CTX_ORG="${CTX_ORG:-phytomedic}"
AGENT="${OVERVIEW_PUSH_AGENT:-user-proxy}"
CHAT_ID="${OVERVIEW_PUSH_CHAT_ID:-353207237}"
CORTEXTOS="${CORTEXTOS:-$(command -v cortextos || echo /opt/homebrew/bin/cortextos)}"

LOG_DIR="$CTX_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/feature-overview-push.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# bus calls need an agent identity (CLI exits if CTX_AGENT_NAME is unset);
# send-telegram reads the bot token from the agent's .env under CTX_AGENT_DIR.
export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$AGENT"

MSG=$("$CORTEXTOS" bus overview --format telegram 2>>"$LOG")
if [ -z "$MSG" ]; then
  echo "[$(ts)] overview empty — nothing sent" >> "$LOG"
  exit 0
fi

if "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" >>"$LOG" 2>&1; then
  echo "[$(ts)] pushed overview to chat $CHAT_ID (agent=$AGENT)" >> "$LOG"
else
  echo "[$(ts)] send-telegram FAILED (agent=$AGENT chat=$CHAT_ID)" >> "$LOG"
fi
exit 0
