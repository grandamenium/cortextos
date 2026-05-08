#!/usr/bin/env bash
# hook-vault-precompact.sh — save session context to vault before compaction
# Called as a PreCompact hook. Must complete in <5s.
set -euo pipefail

INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true

AGENT="${CTX_AGENT_NAME:-unknown}"
VAULT_DIR="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}/obsidian-vault/${AGENT}/working-context"
mkdir -p "$VAULT_DIR"

SESSION_FILE="$VAULT_DIR/active-session.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATE=$(date -u +"%Y-%m-%d")

# Write compaction checkpoint — captured before context is lost
cat > "$SESSION_FILE" << SNAPSHOT
# Active Session Snapshot — $AGENT
> Saved at compaction: $TIMESTAMP

## Session date: $DATE

## Daily log path
/Users/arndt/cortextos/obsidian-vault/${AGENT}/daily/${DATE}.md

## Last heartbeat
$(cat "${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}/state/${CTX_INSTANCE_ID:-default}/${AGENT}/heartbeat.json" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d.get('status','?'), '| Last HB:', d.get('last_heartbeat','?'))" 2>/dev/null || echo "heartbeat unreadable")

## Read on resume
- /Users/arndt/cortextos/obsidian-vault/agent-shared/READ-ON-BOOT.md
- /Users/arndt/cortextos/obsidian-vault/${AGENT}/daily/${DATE}.md
- GUARDRAILS.md, GOALS.md, MEMORY.md
SNAPSHOT

echo '{}' 
