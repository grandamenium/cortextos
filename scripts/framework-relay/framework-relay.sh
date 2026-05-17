#!/bin/bash
# framework-relay.sh — bidirectional cross-instance agent framework-file sync
# (Mac mini ↔ MacBook).
#
# Per chief dispatch 1778592013141 (M-sam-5 / M-sam-dual-path). Sibling to:
#   - bus-relay.sh (30s, point-to-point bus messages, --remove-source-files)
#   - memory-relay.sh (300s, persistent memory files, --update)
# This script (900s = 15min, framework files, --update) completes the trio.
#
# Why this exists: the same agent has TWO framework-file locations
#   1. Mac mini cortextos/orgs/subbu-ops/agents/<agent>/  (used by security-vp
#      static review, dashboard surfacing, KB metadata, Mac-mini-side tooling)
#   2. MacBook  ~/cortextos/orgs/subbu-ops/agents/<agent>/  (sam runtime reads
#      these on session start; future MacBook agents will too)
# Without sync, edits on one side leave the other stale (security-vp FAIL on
# 2026-05-12 — see outputs/security-review-sam-2026-05-12.md root cause).
#
# What gets synced (per-agent):
#   IDENTITY.md, SOUL.md, GUARDRAILS.md, USER.md, GOALS.md, CLAUDE.md,
#   goals.json, config.json
#
# What is NOT synced:
#   - .env (per-instance BOT_TOKEN/CHAT_ID/ALLOWED_USER — must stay host-local)
#   - memory/, MEMORY.md (handled by memory-relay.sh at 5min cadence)
#   - HEARTBEAT.md, AGENTS.md, TOOLS.md, SYSTEM.md, ONBOARDING.md (template-
#     wide; updated via cortextos repo deploy not per-agent sync)
#
# config.json care: each agent has a clear home host (sam→MacBook, all others
# →Mac mini). config.json edits SHOULD happen on the home host so --update
# naturally picks the right version. WARNING: do NOT edit config.json on the
# non-home host — that would race with home-host edits and may overwrite
# legitimate per-host divergence (BOT_TOKEN reference, cron set). If you find
# yourself wanting to edit on the wrong host, ssh to the right one or modify
# this script to add field-level merge.
#
# Lane discipline: this script ONLY touches agent framework dirs
# (cortextos/orgs/<org>/agents/<agent>/<known-file>). Does NOT touch
# .env files, memory/ (sibling relay handles), state/ (~/.cortextos/), or
# analyst-managed services.
set -uo pipefail

SSH_CONFIG="$HOME/.ssh/config_macbook"
MACBOOK_HOST="macbook-m4"
MM_AGENTS_DIR="$HOME/cortextos/orgs/subbu-ops/agents"
MB_AGENTS_DIR_REMOTE='$HOME/cortextos/orgs/subbu-ops/agents'
LOG_FILE="$HOME/.cortextos/default/logs/framework-relay.log"

# All agents — AUTO-DISCOVERED from enabled-agents.json union on both hosts
# (security-vp consolidated dispatch 1778611025719 A2 = M-sam-6, addressed
# 2026-05-12T19:00Z). Replaces the prior hardcoded list which silently dropped
# new agents at relay scope (Layer 3 of the iterative-discovery thread).
#
# Approach:
# 1. Always read Mac mini's enabled-agents.json (local).
# 2. Attempt to read MacBook's enabled-agents.json via SSH with short timeout.
# 3. Union the agent-name keys from both files.
# 4. Fall back to Mac-mini-only if SSH fails (degraded but not broken — same as
#    old behavior for Mac-mini-side agents).
#
# Both sides' enabled-agents.json includes ALL scaffolded agents (enabled=true
# AND enabled=false) so framework-relay correctly syncs files for not-yet-enabled
# agents during their scaffold/onboarding phase.

MM_ENABLED_JSON="$HOME/.cortextos/default/config/enabled-agents.json"
MB_ENABLED_JSON_REMOTE="/Users/hari/.cortextos/default/config/enabled-agents.json"
SSH_DISCOVER="ssh -F $HOME/.ssh/config_macbook -o ConnectTimeout=3 -o LogLevel=ERROR macbook-m4"

discover_agents() {
  local mm_list mb_list
  if [ -f "$MM_ENABLED_JSON" ]; then
    mm_list=$(python3 -c "
import json
print('\n'.join(json.load(open('$MM_ENABLED_JSON')).keys()))
" 2>/dev/null)
  fi
  mb_list=$($SSH_DISCOVER "python3 -c 'import json; print(\"\\n\".join(json.load(open(\"$MB_ENABLED_JSON_REMOTE\")).keys()))'" 2>/dev/null)
  printf '%s\n%s\n' "$mm_list" "$mb_list" | sort -u | grep -v '^$'
}

# bash 3.2 (macOS default) lacks `readarray`; portable line-by-line read instead.
AGENTS=()
while IFS= read -r _line; do
  [ -n "$_line" ] && AGENTS+=("$_line")
done < <(discover_agents)
# Sanity fallback: if discovery produced nothing (both files unreadable),
# preserve the prior hardcoded list so the relay isn't a complete no-op.
if [ "${#AGENTS[@]}" -eq 0 ]; then
  AGENTS=(chief analyst dev security-vp redteam blueteam home-net research forge sam warden-mm warden-mb)
fi

# Files to sync per agent. Order is meaningful only for log readability.
FILES=(IDENTITY.md SOUL.md GUARDRAILS.md USER.md GOALS.md CLAUDE.md goals.json config.json)

mkdir -p "$(dirname "$LOG_FILE")"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

SSH_CMD="ssh -F $SSH_CONFIG -o ConnectTimeout=5 -o LogLevel=ERROR"

total_xfer=0

for agent in "${AGENTS[@]}"; do
  for file in "${FILES[@]}"; do
    for direction in "pull" "push"; do
      if [ "$direction" = "pull" ]; then
        src="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/$file"
        dst="$MM_AGENTS_DIR/$agent/$file"
        # Auto-bootstrap dst dir for MacBook-originated agents (e.g., warden-mb).
        # Previously a guard "skip if dst parent missing" silently skipped
        # PULL forever for any agent scaffolded only on MacBook side — surfaced
        # 2026-05-12T13:35Z by security-vp during warden pair review (M-sam-6
        # concrete instance). Fix per chief approval (msg 1778593035346):
        # mkdir -p the dst dir so rsync can land the files. Push direction
        # already does this via --rsync-path; pull now matches.
        mkdir -p "$(dirname "$dst")"
      else
        # Skip if source doesn't exist locally
        [ -f "$MM_AGENTS_DIR/$agent/$file" ] || continue
        src="$MM_AGENTS_DIR/$agent/$file"
        dst="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/$file"
      fi
      out=$(rsync -a --update -e "$SSH_CMD" --stats \
        --rsync-path="mkdir -p $MB_AGENTS_DIR_REMOTE/$agent && rsync" \
        "$src" "$dst" 2>&1) || {
        # Source-missing failures are normal for some agent/file combos.
        # Quiet-skip those; loud-log everything else.
        if echo "$out" | grep -q "No such file or directory"; then
          :  # silent skip
        else
          log "$direction $agent/$file FAIL: ${out:0:200}"
        fi
        continue
      }
      added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
      if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
        log "$direction $agent/$file +$added"
        total_xfer=$((total_xfer + added))
      fi
    done
  done
done

# --- M-sam-7: per-agent .claude/skills/ recursive sync (push+pull, --update) ---
#
# Top-level FILES loop above misses anything under .claude/skills/<skill>/
# (SKILL.md, supporting docs, helper scripts). Surfaced 2026-05-12T14:00Z when
# warden-mb's .claude/skills/context-scan/SKILL.md was empty on Mac mini after
# warden-mb framework files relayed — security-vp could not start diff review
# until SKILL.md was hand-written via Write tool. Fix per chief approval
# (msg 1778596252423): extend relay to also recursively sync .claude/skills/.
#
# Lane scope unchanged: per-agent only. Does NOT touch .claude/settings.json
# (Telegram hooks live there + paths are per-host, must stay host-local).
# Does NOT touch templates/agent/.claude/ (template deploy path).
for agent in "${AGENTS[@]}"; do
  for direction in "pull" "push"; do
    if [ "$direction" = "pull" ]; then
      src="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/.claude/skills/"
      dst="$MM_AGENTS_DIR/$agent/.claude/skills/"
      mkdir -p "$dst"
    else
      [ -d "$MM_AGENTS_DIR/$agent/.claude/skills" ] || continue
      src="$MM_AGENTS_DIR/$agent/.claude/skills/"
      dst="$MACBOOK_HOST:$MB_AGENTS_DIR_REMOTE/$agent/.claude/skills/"
    fi
    out=$(rsync -a --update -e "$SSH_CMD" --stats \
      --rsync-path="mkdir -p $MB_AGENTS_DIR_REMOTE/$agent/.claude/skills && rsync" \
      "$src" "$dst" 2>&1) || {
      # Source-missing (agent has no skills/ dir on the source side) is normal.
      if echo "$out" | grep -q "No such file or directory"; then
        :
      else
        log "$direction $agent/.claude/skills/ FAIL: ${out:0:200}"
      fi
      continue
    }
    added=$(echo "$out" | awk '/Number of (regular )?files transferred:/ {print $NF}')
    if [ -n "${added:-}" ] && [ "$added" -gt 0 ]; then
      log "$direction $agent/.claude/skills/ +$added"
      total_xfer=$((total_xfer + added))
    fi
  done
done

if [ "$total_xfer" -gt 5 ]; then
  log "cycle total: $total_xfer transfers"
fi
