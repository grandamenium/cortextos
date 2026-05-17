#!/bin/bash
# bus-relay.sh — bidirectional cross-instance bus relay (Mac mini ↔ MacBook)
#
# Phase 2 implementation per chief dispatch 1778561818966 + analyst lane lock.
# Mirrors analyst's chromadb-sync rsync pattern, but for bus inbox dirs.
#
# Direction A (PULL): MacBook ~/.cortextos/default/inbox/<MM_AGENT>/ → Mac mini ~/.cortextos/default/inbox/<MM_AGENT>/
#   Picks up messages sam (or any future MacBook-local agent) sends to a Mac mini agent.
# Direction B (PUSH): Mac mini ~/.cortextos/default/inbox/<MB_AGENT>/ → MacBook ~/.cortextos/default/inbox/<MB_AGENT>/
#   Picks up messages chief (or any Mac mini agent) sends to a MacBook agent.
#
# Idempotent: rsync --ignore-existing dedups by (filename in inbox dir = msg_id).
# Once an agent ACKs a message it moves to processed/ — that's a separate lane,
# this relay only ever sees the inbox/ side, so no risk of re-delivering ACK'd messages.
#
# Lane discipline: this script touches ONLY ~/.cortextos/<instance>/inbox/<agent>/ paths.
# Does NOT touch analyst's lanes (tailscaled, ollama, chromadb-sync, venv, models).
#
# Run cadence: every 30s via launchd.
set -uo pipefail  # no -e so one failed agent doesn't break the whole pass

SSH_CONFIG="$HOME/.ssh/config_macbook"
MACBOOK_HOST="macbook-m4"
MM_INBOX="$HOME/.cortextos/default/inbox"
MB_INBOX_REMOTE='$HOME/.cortextos/default/inbox'
# (changed 2026-05-12: sam now runs on MacBook DEFAULT instance, not macbook instance)
# (the abandoned ~/.cortextos/macbook/ tree on MacBook is orphaned cruft, not used)
LOG_FILE="$HOME/.cortextos/default/logs/bus-relay.log"

# Agents on each side — AUTO-DISCOVERED from each side's enabled-agents.json
# (security-vp consolidated dispatch 1778611025719 D2, addressed 2026-05-12T19:00Z).
# Replaces the prior hardcoded lists which silently dropped new agents at relay
# scope (same Layer-3 pattern as framework-relay M-sam-6).
#
# MM_AGENTS = keys of Mac mini's enabled-agents.json (agents Mac-mini-side will
#             receive bus messages forwarded FROM MacBook)
# MB_AGENTS = keys of MacBook's enabled-agents.json (agents MacBook-side will
#             receive bus messages forwarded FROM Mac mini)
#
# Includes ALL scaffolded agents (enabled=true AND enabled=false) so bus
# messages addressed to a not-yet-enabled agent are correctly queued for when
# it comes online, rather than silently dropped.

MM_ENABLED_JSON="$HOME/.cortextos/default/config/enabled-agents.json"
MB_ENABLED_JSON_REMOTE="/Users/hari/.cortextos/default/config/enabled-agents.json"
SSH_DISCOVER="ssh -F $HOME/.ssh/config_macbook -o ConnectTimeout=3 -o LogLevel=ERROR macbook-m4"

# Discover Mac mini agents
MM_AGENTS=()
if [ -f "$MM_ENABLED_JSON" ]; then
  while IFS= read -r _line; do
    [ -n "$_line" ] && MM_AGENTS+=("$_line")
  done < <(python3 -c "
import json
print('\n'.join(json.load(open('$MM_ENABLED_JSON')).keys()))
" 2>/dev/null)
fi

# Discover MacBook agents via SSH
MB_AGENTS=()
while IFS= read -r _line; do
  [ -n "$_line" ] && MB_AGENTS+=("$_line")
done < <($SSH_DISCOVER "python3 -c 'import json; print(\"\\n\".join(json.load(open(\"$MB_ENABLED_JSON_REMOTE\")).keys()))'" 2>/dev/null)

# Sanity fallback: if discovery produced nothing, preserve the prior hardcoded
# lists so the relay isn't a complete no-op.
if [ "${#MM_AGENTS[@]}" -eq 0 ]; then
  MM_AGENTS=(chief analyst dev security-vp redteam blueteam home-net research forge warden-mm)
fi
if [ "${#MB_AGENTS[@]}" -eq 0 ]; then
  MB_AGENTS=(sam warden-mb)
fi

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$MM_INBOX"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Direction A: PULL MacBook→MacMini for each Mac mini agent
for agent in "${MM_AGENTS[@]}"; do
  mkdir -p "$MM_INBOX/$agent"
  # --remove-source-files: after successful transfer, delete source.
  # Critical for cross-instance bus: without it, the recipient's processed/ move
  # (after ack) leaves the source still present on sender's inbox/, and
  # --ignore-existing alone re-delivers the same file every cycle (because dest
  # inbox/ is empty after processing, so dest doesn't have it = "new").
  # With --remove-source-files: source-side file deleted post-transfer, no
  # redelivery on subsequent cycles. Each message ships exactly once.
  out=$(rsync -a --ignore-existing --remove-source-files \
    -e "ssh -F $SSH_CONFIG -o ConnectTimeout=5 -o LogLevel=ERROR" \
    --stats \
    "$MACBOOK_HOST:$MB_INBOX_REMOTE/$agent/" \
    "$MM_INBOX/$agent/" 2>&1) || {
    log "PULL $agent FAIL: ${out:0:200}"
    continue
  }
  added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
  if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
    log "PULL $agent +$added msgs"
  fi
done

# Direction B: PUSH MacMini→MacBook for each MacBook agent
for agent in "${MB_AGENTS[@]}"; do
  mkdir -p "$MM_INBOX/$agent"  # ensure source dir exists locally
  # --remove-source-files: after successful transfer, delete source.
  # Critical for cross-instance bus: without it, the recipient's processed/ move
  # (after ack) leaves the source still present on sender's inbox/, and
  # --ignore-existing alone re-delivers the same file every cycle (because dest
  # inbox/ is empty after processing, so dest doesn't have it = "new").
  # With --remove-source-files: source-side file deleted post-transfer, no
  # redelivery on subsequent cycles. Each message ships exactly once.
  out=$(rsync -a --ignore-existing --remove-source-files \
    -e "ssh -F $SSH_CONFIG -o ConnectTimeout=5 -o LogLevel=ERROR" \
    --stats \
    --rsync-path="mkdir -p $MB_INBOX_REMOTE/$agent && rsync" \
    "$MM_INBOX/$agent/" \
    "$MACBOOK_HOST:$MB_INBOX_REMOTE/$agent/" 2>&1) || {
    log "PUSH $agent FAIL: ${out:0:200}"
    continue
  }
  added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
  if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
    log "PUSH $agent +$added msgs"
  fi
done
