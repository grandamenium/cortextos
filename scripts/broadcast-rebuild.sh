#!/usr/bin/env bash
# broadcast-rebuild.sh — Wake-nudge all alive agents to rebuild their cortextos dist.
#
# Called by:
#   - scripts/hooks/post-merge   (fires automatically after git merge/pull)
#   - scripts/self-healing/cortextos-src-watch.sh  (detects stale dist)
#   - manually: bash scripts/broadcast-rebuild.sh
#
# Safe to run multiple times — agents that are already up-to-date will ignore
# the nudge after their next git fetch shows no diff.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[broadcast-rebuild] ERROR: must be run inside the cortextos git repo" >&2
  exit 1
}

MERGE_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")

REBUILD_MSG="[cortextos-rebuild] cortextos-improver rebuilt dist to $MERGE_SHA. Shared binary updated — pick up on next cold-start. No action needed unless you own a separate cortextos checkout."

if ! command -v cortextos &>/dev/null; then
  echo "[broadcast-rebuild] WARNING: cortextos CLI not in PATH — skipping broadcast" >&2
  exit 0
fi

AGENTS_JSON=$(cortextos bus list-agents --format json 2>/dev/null || echo "[]")
SELF="${CTX_AGENT_NAME:-}"

COUNT=0
while IFS= read -r agent; do
  [ -z "$agent" ] && continue
  [ "$agent" = "$SELF" ] && continue
  cortextos bus send-message "$agent" normal "$REBUILD_MSG" 2>/dev/null && COUNT=$((COUNT + 1)) || true
done < <(python3 -c "
import json, sys
agents = json.loads(sys.stdin.read())
for a in agents:
    if a.get('running') or a.get('enabled'):
        print(a['name'])
" <<< "$AGENTS_JSON" 2>/dev/null)

echo "[broadcast-rebuild] Nudged $COUNT agents (SHA: $MERGE_SHA)"
