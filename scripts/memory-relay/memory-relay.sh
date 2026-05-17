#!/bin/bash
# memory-relay.sh — bidirectional cross-instance agent-memory sync (Mac mini ↔ MacBook).
#
# Per chief dispatch 1778591766385 + Hari directive: make HARPAL Enterprise act as
# one brain by syncing every agent's memory files across both cortextOS instances.
# Sibling to bus-relay.sh (point-to-point messages) — this handles long-lived
# memory state instead.
#
# What gets synced (per-agent):
#   - agents/<agent>/memory/  (daily YYYY-MM-DD.md files)
#   - agents/<agent>/MEMORY.md  (long-term consolidated learnings)
#
# Sync semantics:
#   - rsync -a --update  (newer mtime wins; idempotent; no --delete; no --remove-source-files)
#   - Bidirectional, runs in BOTH directions every cycle. Each agent typically
#     writes only on its home host (sam→MacBook, all others→Mac mini), so in
#     practice one direction is always the winner per file. --update handles
#     edge cases (clock skew, future MacBook-side agents) without conflict.
#   - Destination writes via tmp+rename (rsync default) → atomic at dest. A
#     mid-write source-side file may give partial content for one cycle only;
#     next cycle corrects. Acceptable per design (analyst confirmed safe).
#
# Cadence: 5 min (StartInterval=300) via launchd. Less frequent than bus-relay
# (30s) because memory changes are infrequent + slow vs message traffic.
#
# Lane discipline: this script ONLY touches agent memory paths
# (cortextos/orgs/<org>/agents/<agent>/memory/ + MEMORY.md). Does NOT touch
# analyst-managed services (tailscaled, ollama, chromadb-sync) or per-agent
# state dirs (~/.cortextos/*/state/), the bus relay's lane.
set -uo pipefail

SSH_CONFIG="$HOME/.ssh/config_macbook"
MACBOOK_HOST="macbook-m4"
MM_AGENTS_DIR="$HOME/cortextos/orgs/subbu-ops/agents"
MB_AGENTS_DIR_REMOTE='$HOME/cortextos/orgs/subbu-ops/agents'
LOG_FILE="$HOME/.cortextos/default/logs/memory-relay.log"

# All agents (Mac mini side + MacBook side). Both hosts are expected to have
# the per-agent dir + memory/ subdir + MEMORY.md (created at scaffold time;
# this script does NOT create them — bootstrap script ran once at setup).
AGENTS=(chief analyst dev security-vp redteam blueteam home-net research forge sam)

mkdir -p "$(dirname "$LOG_FILE")"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Per-agent: sync memory/ and MEMORY.md in both directions.
# rsync -a (archive) + --update (newer wins) + -e ssh via tailnet config.
# 5s connect timeout + LogLevel=ERROR to keep log clean on transient netfail.
SSH_CMD="ssh -F $SSH_CONFIG -o ConnectTimeout=5 -o LogLevel=ERROR"

total_xfer=0

for agent in "${AGENTS[@]}"; do
  # ---- agents/<agent>/memory/ — daily files ----
  for direction in "pull" "push"; do
    if [ "$direction" = "pull" ]; then
      src="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/memory/"
      dst="$MM_AGENTS_DIR/$agent/memory/"
    else
      src="$MM_AGENTS_DIR/$agent/memory/"
      dst="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/memory/"
    fi
    out=$(rsync -a --update -e "$SSH_CMD" --stats \
      --rsync-path="mkdir -p $MB_AGENTS_DIR_REMOTE/$agent/memory && rsync" \
      "$src" "$dst" 2>&1) || {
      log "$direction $agent/memory/ FAIL: ${out:0:200}"
      continue
    }
    added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
    if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
      log "$direction $agent/memory/ +$added files"
      total_xfer=$((total_xfer + added))
    fi
  done

  # ---- agents/<agent>/MEMORY.md — single file, bidirectional --update ----
  # Note: rsync can sync a single file directly. Skip if source doesn't exist
  # (e.g., sam has no MEMORY.md on Mac mini side yet — that's fine).
  for direction in "pull" "push"; do
    if [ "$direction" = "pull" ]; then
      src="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/MEMORY.md"
      dst="$MM_AGENTS_DIR/$agent/MEMORY.md"
    else
      # Skip push if source doesn't exist locally
      [ -f "$MM_AGENTS_DIR/$agent/MEMORY.md" ] || continue
      src="$MM_AGENTS_DIR/$agent/MEMORY.md"
      dst="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/MEMORY.md"
    fi
    out=$(rsync -a --update -e "$SSH_CMD" --stats \
      --rsync-path="mkdir -p $MB_AGENTS_DIR_REMOTE/$agent && rsync" \
      "$src" "$dst" 2>&1) || {
      # Source-missing failures are normal (some agents may not have MEMORY.md
      # on one side yet). Quiet-skip those; loud-log everything else.
      if echo "$out" | grep -q "No such file or directory"; then
        :  # silent skip
      else
        log "$direction $agent/MEMORY.md FAIL: ${out:0:200}"
      fi
      continue
    }
    added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
    if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
      log "$direction $agent/MEMORY.md +$added"
      total_xfer=$((total_xfer + added))
    fi
  done
done

# Optional summary line on busy cycles
if [ "$total_xfer" -gt 5 ]; then
  log "cycle total: $total_xfer transfers"
fi
