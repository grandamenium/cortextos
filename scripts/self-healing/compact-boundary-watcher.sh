#!/bin/bash
# Compact-boundary watcher for cortextOS.
# Scans every active Claude Code session JSONL and emits a Telegram hint when
# context (cache_read+cache_create) crosses a tier boundary at a text-only or
# 5-min-idle turn — surfacing the operator-typed /compact moment that agents
# cannot self-invoke. Backstop against the runaway-session class of incident
# (BL-2026-05-11-002, references session 28ec1a74's 146M-token / $334 burn).
#
# Tiers (tunable via COMPACT_TIERS, K tokens):
#   120 / 150 / 170 — maps to ~60/75/85% of the 200K default context limit.
#   For 1M-Opus deployments override e.g. COMPACT_TIERS="350,500,700".
#
# Idempotency: max 1 hint per (session, tier). State file at
# $HOME/.cortextos/$INSTANCE/compact-watcher-state.tsv with rows
# `session_id<TAB>tier_k<TAB>ts_iso`.
#
# Runs every 10 minutes via launchd. See README.md for install steps.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
ANALYZE_PY="${COMPACT_ANALYZE_PY:-$FRAMEWORK_ROOT/scripts/session-analysis/analyze.py}"
STATE_DIR="$HOME/.cortextos/$INSTANCE"
STATE_FILE="$STATE_DIR/compact-watcher-state.tsv"
LOG_FILE="$STATE_DIR/logs/compact-boundary-watcher.log"

# Tiers in K tokens, ascending.
TIERS_RAW="${COMPACT_TIERS:-120,150,170}"
# Activity window. Cron cadence is 10 min; window of 5 min keeps hints "fresh"
# (don't re-alert on a session that went idle 8 min ago).
SINCE_MINUTES="${COMPACT_SINCE_MINUTES:-5}"

JQ_BIN="$(command -v jq)"
PYTHON_BIN="$(command -v python3)"
[ -z "$JQ_BIN" ] && { echo "compact-boundary-watcher: jq not on PATH" >&2; exit 1; }
[ -z "$PYTHON_BIN" ] && { echo "compact-boundary-watcher: python3 not on PATH" >&2; exit 1; }
[ -f "$ANALYZE_PY" ] || { echo "compact-boundary-watcher: analyze.py not at $ANALYZE_PY (set COMPACT_ANALYZE_PY or CTX_FRAMEWORK_ROOT)" >&2; exit 1; }

# Auto-detect alert bot — same pattern as usage-monitor.sh.
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

BOT_TOKEN=""
CHAT_ID=""
if [ -n "$ALERT_BOT_ENV" ] && [ -f "$ALERT_BOT_ENV" ]; then
  BOT_TOKEN=$(grep -E "^BOT_TOKEN=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
  CHAT_ID=$(grep -E "^CHAT_ID=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
fi

mkdir -p "$STATE_DIR/logs"
touch "$STATE_FILE"
ts_now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
log_ts="$(date '+%Y-%m-%d %H:%M:%S')"

# Lowest tier drives the analyze.py threshold.
MIN_TIER=$(echo "$TIERS_RAW" | tr ',' '\n' | sort -n | head -1)

CANDIDATES_JSON=$("$PYTHON_BIN" "$ANALYZE_PY" recent-candidates \
  --since-minutes "$SINCE_MINUTES" \
  --threshold "$MIN_TIER" \
  --format json 2>>"$LOG_FILE")

if [ -z "$CANDIDATES_JSON" ] || [ "$CANDIDATES_JSON" = "[]" ]; then
  echo "[$log_ts] no candidates (threshold ${MIN_TIER}K, window ${SINCE_MINUTES}m)" >> "$LOG_FILE"
  exit 0
fi

count=$(echo "$CANDIDATES_JSON" | "$JQ_BIN" 'length')
echo "[$log_ts] $count candidate(s) at threshold ${MIN_TIER}K, window ${SINCE_MINUTES}m" >> "$LOG_FILE"

echo "$CANDIDATES_JSON" | "$JQ_BIN" -c '.[]' | while read -r row; do
  session_id=$(echo "$row" | "$JQ_BIN" -r '.session_id')
  agent_name=$(echo "$row" | "$JQ_BIN" -r '.agent_name // "unknown"')
  branch=$(echo "$row" | "$JQ_BIN" -r '.branch // "unknown"')
  cache_read=$(echo "$row" | "$JQ_BIN" -r '.cache_read')
  context_total=$(echo "$row" | "$JQ_BIN" -r '.context_total')
  timestamp=$(echo "$row" | "$JQ_BIN" -r '.timestamp')
  why=$(echo "$row" | "$JQ_BIN" -r '.why')

  # Defensive: skip rows where context_total isn't a positive integer
  # (e.g. an assistant row with no usage block — analyze.py would emit 0,
  # but jq's // fallback or upstream schema drift could yield "null").
  if ! [[ "$context_total" =~ ^[0-9]+$ ]] || [ "$context_total" -eq 0 ]; then
    echo "[$log_ts]   skip $agent_name $session_id (no context_total: '$context_total')" >> "$LOG_FILE"
    continue
  fi

  # Highest crossed tier (the alert speaks to the most urgent level reached).
  crossed_tier=""
  for tier_k in $(echo "$TIERS_RAW" | tr ',' ' '); do
    tier_tokens=$((tier_k * 1000))
    if [ "$context_total" -ge "$tier_tokens" ]; then
      crossed_tier="$tier_k"
    fi
  done
  [ -z "$crossed_tier" ] && continue

  # Idempotency — skip if (session, tier) already alerted.
  if awk -v sid="$session_id" -v tier="$crossed_tier" -F'\t' \
      '$1==sid && $2==tier {found=1; exit} END {exit !found}' "$STATE_FILE"; then
    echo "[$log_ts]   skip $agent_name $session_id tier=${crossed_tier}K (already alerted)" >> "$LOG_FILE"
    continue
  fi

  cr_human=$(awk -v n="$cache_read" 'BEGIN {
    if (n>=1000000) printf "%.1fM", n/1000000;
    else if (n>=1000) printf "%.1fK", n/1000;
    else print n
  }')

  # Quote the canned /compact phase-boundary prompt inline so operator can copy-paste.
  msg="🧹 *Compact-boundary hint — ${agent_name}*
Session: \`${session_id:0:8}\`
Branch: \`${branch}\`
Context: *${cr_human}* cache_read (tier ${crossed_tier}K, ${why})
Last turn: ${timestamp:0:19}

Operator: paste this at the agent prompt to compact at the next phase boundary —

\`\`\`
/compact preserve: current branch name, last 5 commits with their messages, current spec file paths, open file paths, in-flight TODO/blockers, this phase's acceptance criteria. drop: completed code-evaluator subagent transcripts, deep-eval discussions on already-merged PRs, exploration discussions on resolved questions, intermediate debugging chains where the bug is fixed.
\`\`\`"

  if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    response=$(curl -sS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(printf '{"chat_id": %s, "text": %s, "parse_mode": "Markdown"}' "$CHAT_ID" "$(echo "$msg" | "$JQ_BIN" -Rs .)")" 2>&1)
    ok=$(echo "$response" | "$JQ_BIN" -r '.ok // empty' 2>/dev/null)
    if [ "$ok" = "true" ]; then
      echo "[$log_ts]   ALERT $agent_name $session_id tier=${crossed_tier}K cr=${cr_human} branch=$branch" >> "$LOG_FILE"
      printf '%s\t%s\t%s\n' "$session_id" "$crossed_tier" "$ts_now" >> "$STATE_FILE"
    else
      echo "[$log_ts]   ERR  Telegram send failed: $response" >> "$LOG_FILE"
    fi
  else
    # No bot configured — log only. Do NOT record state: once the bot is
    # wired later, prior candidates would otherwise be permanently suppressed.
    echo "[$log_ts]   DRY  (no bot) $agent_name $session_id tier=${crossed_tier}K cr=${cr_human}" >> "$LOG_FILE"
  fi
done
