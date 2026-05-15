#!/bin/bash
# Payload-cap drift monitor for cortextOS.
# Measures each agent's combined cold-boot payload (CLAUDE.md + MEMORY.md +
# HEARTBEAT.md) and Telegram-alerts when it exceeds the per-agent cap. Backstop
# against eager-load creep — the class-of-trap that put boss at 67k pre-instruction
# context (docs_sb/issues/08-boss-bootstrap-context-bloat.md).
#
# Per Anthropic best practice: "Would removing this cause Claude to make
# mistakes? If not, cut it." This cron applies the rule mechanically — when an
# agent drifts above the cap, the operator gets a reminder to audit.
#
# Cap: 15,000 tokens per agent (default; override with PAYLOAD_CAP_TOKENS).
# Token approximation: bytes / 4 (standard rule of thumb, well within the
# noise floor of the cap — we're not optimizing, we're alerting on drift).
#
# Idempotency: max 1 alert per (agent, breach episode). State resets when an
# agent drops back below the cap. State file at
# $HOME/.cortextos/$INSTANCE/payload-cap-state.tsv with rows
# `agent<TAB>tokens<TAB>cap_state<TAB>last_alert_iso`.
#
# Wire into any cron schedule. Recommended cadence: daily or weekly. Can ride
# the existing standby-enforcer launchd job, or run standalone via launchd
# (copy com.cortextos.compact-boundary-watcher.plist.template as a starting
# point). See README.md for install steps.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
STATE_DIR="$HOME/.cortextos/$INSTANCE"
STATE_FILE="$STATE_DIR/payload-cap-state.tsv"
LOG_FILE="$STATE_DIR/logs/payload-cap-drift.log"

# Per-agent payload cap (tokens). Default 15k aligns with Issue 08's analysis
# of cold-boot context budget — beyond this, the cacheable prefix bloats past
# the value of the content it carries.
CAP_TOKENS="${PAYLOAD_CAP_TOKENS:-15000}"

# Files counted in the per-agent payload. Each is loaded at every Session Start
# per the agent CLAUDE.md "Read these on every boot" block.
PAYLOAD_FILES=("CLAUDE.md" "MEMORY.md" "HEARTBEAT.md")

JQ_BIN="$(command -v jq)"
[ -z "$JQ_BIN" ] && { echo "payload-cap-drift: jq not on PATH" >&2; exit 1; }

mkdir -p "$STATE_DIR/logs"
touch "$STATE_FILE"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

# Auto-detect alert bot — same pattern as compact-boundary-watcher.sh.
ALERT_BOT_ENV="${CORTEXTOS_ALERT_BOT_ENV:-}"
if [ -z "$ALERT_BOT_ENV" ]; then
  for ctx in "$FRAMEWORK_ROOT"/orgs/*/context.json; do
    [ -f "$ctx" ] || continue
    orch=$("$JQ_BIN" -r '.orchestrator // empty' "$ctx")
    [ -z "$orch" ] && continue
    org=$(basename "$(dirname "$ctx")")
    candidate="$FRAMEWORK_ROOT/orgs/$org/agents/$orch/.env"
    [ -f "$candidate" ] && ALERT_BOT_ENV="$candidate" && break
  done
fi

ALLOWED_CHAT_ID=""
if [ -n "$ALERT_BOT_ENV" ] && [ -f "$ALERT_BOT_ENV" ]; then
  # Targeted extraction — never `source` an untrusted .env (would let any key
  # in the file override JQ_BIN / STATE_FILE / FRAMEWORK_ROOT etc.). Matches
  # the compact-boundary-watcher.sh family convention.
  ALLOWED_CHAT_ID=$(grep -E "^CTX_TELEGRAM_CHAT_ID=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"'')
  [ -z "$ALLOWED_CHAT_ID" ] && ALLOWED_CHAT_ID=$(grep -E "^ALLOWED_USER=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"'')
fi

send_alert() {
  local agent="$1" tokens="$2"
  local msg
  msg=$(printf 'payload-cap drift: agent=%s tokens≈%d (cap=%d). Audit %s/orgs/*/agents/%s/{CLAUDE,MEMORY,HEARTBEAT}.md — "would removing this cause Claude to make mistakes? if not, cut it."' \
    "$agent" "$tokens" "$CAP_TOKENS" "$FRAMEWORK_ROOT" "$agent")
  if [ -z "$ALLOWED_CHAT_ID" ]; then
    log "no alert chat configured — would have sent: $msg"
    return 0
  fi
  if [ -x "$FRAMEWORK_ROOT/scripts/comms/send-telegram-guarded.sh" ]; then
    # Pass INSTANCE through so guarded-send's dedupe cache lands under the
    # right ~/.cortextos/<instance>/ for non-default deployments.
    CTX_AGENT_NAME="payload-cap-drift" \
      CTX_FRAMEWORK_ROOT="$FRAMEWORK_ROOT" \
      CTX_INSTANCE_ID="$INSTANCE" \
      bash "$FRAMEWORK_ROOT/scripts/comms/send-telegram-guarded.sh" \
        "$ALLOWED_CHAT_ID" "$msg" >> "$LOG_FILE" 2>&1
  else
    log "send-telegram-guarded.sh not found — alert dropped: $msg"
  fi
}

# Read prior state for (agent, cap_state) idempotency.
last_state_for() {
  local agent="$1"
  awk -v a="$agent" -F'\t' '$1==a {print $3; exit}' "$STATE_FILE"
}

# Accumulate new state in memory and write the full file once at end with a
# PID-namespaced tmp. This eliminates the per-iteration rewrite race that two
# concurrent invocations would otherwise hit on a shared $STATE_FILE.tmp.
declare -a NEW_STATE_ROWS=()

stage_state() {
  local agent="$1" tokens="$2" cap_state="$3"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  NEW_STATE_ROWS+=("$(printf '%s\t%s\t%s\t%s' "$agent" "$tokens" "$cap_state" "$now")")
}

commit_state() {
  local tmp="${STATE_FILE}.$$.tmp"
  : > "$tmp"
  local row
  for row in "${NEW_STATE_ROWS[@]}"; do
    printf '%s\n' "$row" >> "$tmp"
  done
  mv "$tmp" "$STATE_FILE"
}

# Walk every agent under orgs/*/agents/.
exit_code=0
for agent_dir in "$FRAMEWORK_ROOT"/orgs/*/agents/*/; do
  [ -d "$agent_dir" ] || continue
  agent=$(basename "$agent_dir")
  # Skip dotfiles / placeholder dirs and reject any name with whitespace —
  # a newline in $agent would corrupt the TSV state file.
  case "$agent" in
    .*) continue ;;
    *[$'\n\t ']*) log "skip agent with whitespace in name: $(printf %q "$agent")"; continue ;;
  esac

  total_bytes=0
  for f in "${PAYLOAD_FILES[@]}"; do
    file="$agent_dir/$f"
    [ -f "$file" ] || continue
    bytes=$(wc -c < "$file" | tr -d ' ')
    total_bytes=$((total_bytes + bytes))
  done

  tokens=$((total_bytes / 4))
  prev_state=$(last_state_for "$agent")
  [ -z "$prev_state" ] && prev_state="under"

  if [ "$tokens" -gt "$CAP_TOKENS" ]; then
    log "agent=$agent tokens=$tokens cap=$CAP_TOKENS state=OVER prev=$prev_state"
    if [ "$prev_state" != "over" ]; then
      send_alert "$agent" "$tokens"
    fi
    stage_state "$agent" "$tokens" "over"
    exit_code=1
  else
    log "agent=$agent tokens=$tokens cap=$CAP_TOKENS state=under prev=$prev_state"
    stage_state "$agent" "$tokens" "under"
  fi
done

commit_state
exit $exit_code
