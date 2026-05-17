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

# Agents on each side — HARDCODED host registry per actual deployment.
#
# REVERTED 2026-05-15 by analyst (Hari directive): the auto-discovery from
# enabled-agents.json (security-vp dispatch 1778611025719 D2, 2026-05-12T19:00Z)
# was BROKEN. enabled-agents.json on both sides lists ALL known agents (it is
# a registry, not a "hosted here" marker), so sam (MacBook-hosted) was in both
# MM_AGENTS and MB_AGENTS. Result: messages addressed to sam ping-ponged every
# 30 seconds between Mac mini and MacBook (PULL sam pulled sam's inbox AWAY
# from MacBook, then PUSH sam pushed it back, then PULL again, etc.). Sam had
# unreliable read access to his own inbox.
#
# Correct semantic: MM_AGENTS = agents whose RUNTIME HOME is Mac mini, MB_AGENTS =
# agents whose RUNTIME HOME is MacBook. PULL direction (MacBook→MacMini) only
# fires for MM_AGENTS so their messages from MacBook side get pulled HOME.
# PUSH direction (MacMini→MacBook) only fires for MB_AGENTS so their messages
# from Mac mini side get pushed HOME. No agent in both lists.
#
# When adding a new agent: edit this file AND restart the launchd job (or wait
# for next 30s cycle). Each agent's host is known at scaffold time.

MM_AGENTS=(chief analyst dev security-vp redteam blueteam research warden-mm home-net forge research-codex)
MB_AGENTS=(sam warden-mb research-director pa)

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
    --exclude=.lock.d \
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
    --exclude=.lock.d \
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
