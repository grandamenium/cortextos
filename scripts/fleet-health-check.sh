#!/usr/bin/env bash
# fleet-health-check.sh — smart stale-heartbeat detector for analyst
#
# Reduces false "stale" alerts on idle-but-alive agents.
#
# Old rule (analyst CLAUDE.md): flag if heartbeat age > 2x loop_interval.
# Problem: idle agents legitimately quiet for hours, producing noise capitan
# manually dismissed every cycle.
#
# New rule:
#   1. Base threshold = 6h (fallback) or 5x loop_interval when set numeric.
#   2. Heartbeat age <= threshold → skip.
#   3. Heartbeat age > threshold + running=false (per `bus list-agents`)
#      → STALE_VERIFIED (agent process actually gone).
#   4. Heartbeat age > threshold + running=true, no event log entries in the
#      last 1h → STALE_SUSPECT (alive but silent; worth surfacing but not urgent).
#   5. Heartbeat age > threshold + running=true + fresh events → DISMISSED
#      (agent is doing work, just not writing heartbeat.json).
#
# Emits log-events per agent evaluated as stale-candidate:
#   stale_verified  (warning) — process gone, needs attention
#   stale_suspect   (info)    — alive but silent, watch next cycle
#   stale_dismissed (info)    — fresh events, no alert needed
#
# Output: JSON summary on stdout.
#   {"verified":[...], "suspect":[...], "dismissed":[...], "checked":N}

set -u

DEFAULT_THRESHOLD_SEC=$(( 6 * 3600 ))
EVENT_FRESH_WINDOW_SEC=$(( 60 * 60 ))
NOW_TS=$(date -u +%s)
TODAY=$(date -u +%Y-%m-%d)

AGENTS_JSON=$(cortextos bus list-agents 2>/dev/null)
[[ -z "$AGENTS_JSON" ]] && echo '{"error":"list-agents failed"}' && exit 1

VERIFIED='[]'
SUSPECT='[]'
DISMISSED='[]'
CHECKED=0

ORG="${CTX_ORG:-fitnessmama}"
EVENTS_DIR="${CTX_ROOT}/orgs/${ORG}/analytics/events"

# Agent config.json (source of truth for enabled/disabled intent) lives in the
# repo tree, NOT under CTX_ROOT (which holds runtime state + analytics only).
# Prefer CTX_PROJECT_ROOT; fall back to deriving repo root from this script's path.
REPO_ROOT="${CTX_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

while read -r line; do
  [[ -z "$line" ]] && continue
  NAME=$(echo "$line" | jq -r '.name')

  # Skip intentionally-disabled agents (config.json enabled=false). A disabled
  # agent is supposed to be dead, so it must not surface as stale. Placed before
  # the age check and the CHECKED increment so disabled agents don't count toward
  # the `checked` total. jq '.enabled' (NOT '.enabled // true' — jq's // treats
  # false as absent, so `false // true` => true and the skip would never fire).
  # Only an explicit "false" skips; true / null(missing) / malformed all proceed
  # (fail-open — a config we can't parse must not silently hide an agent).
  CONFIG_PATH="${REPO_ROOT}/orgs/${ORG}/agents/${NAME}/config.json"
  if [[ -f "$CONFIG_PATH" ]]; then
    CONFIG_ENABLED=$(jq -r '.enabled' "$CONFIG_PATH" 2>/dev/null)
    [[ "$CONFIG_ENABLED" == "false" ]] && continue
  fi

  RUNNING=$(echo "$line" | jq -r '.running')
  LAST_HB=$(echo "$line" | jq -r '.last_heartbeat // ""')
  [[ -z "$LAST_HB" || "$LAST_HB" == "null" ]] && continue

  HB_TS=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_HB" +%s 2>/dev/null || echo 0)
  [[ "$HB_TS" -eq 0 ]] && continue
  AGE_SEC=$(( NOW_TS - HB_TS ))
  AGE_H=$(( AGE_SEC / 3600 ))

  LI_RAW=$(jq -r '.loop_interval // ""' "${CTX_ROOT}/state/${NAME}/heartbeat.json" 2>/dev/null)
  THRESHOLD=$DEFAULT_THRESHOLD_SEC
  if [[ "$LI_RAW" =~ ^[0-9]+$ ]] && [[ "$LI_RAW" -gt 0 ]]; then
    THRESHOLD=$(( LI_RAW * 5 ))
    [[ $THRESHOLD -lt $DEFAULT_THRESHOLD_SEC ]] && THRESHOLD=$DEFAULT_THRESHOLD_SEC
  fi

  CHECKED=$(( CHECKED + 1 ))
  (( AGE_SEC <= THRESHOLD )) && continue

  # Fresh event log entries in last hour?
  EVENT_FILE="${EVENTS_DIR}/${NAME}/${TODAY}.jsonl"
  FRESH_EVENTS=0
  if [[ -f "$EVENT_FILE" ]]; then
    CUTOFF=$(( NOW_TS - EVENT_FRESH_WINDOW_SEC ))
    FRESH_EVENTS=$(awk -v c="$CUTOFF" '
      {
        # extract "timestamp":"ISO"
        if (match($0, /"timestamp":"[^"]+"/)) {
          ts_str = substr($0, RSTART+13, RLENGTH-14)
          cmd = "date -u -j -f %Y-%m-%dT%H:%M:%SZ \"" ts_str "\" +%s 2>/dev/null"
          cmd | getline ts
          close(cmd)
          if (ts+0 >= c) count++
        }
      }
      END { print count+0 }
    ' "$EVENT_FILE")
  fi

  if [[ "$RUNNING" != "true" ]]; then
    VERIFIED=$(echo "$VERIFIED" | jq -c --arg n "$NAME" --arg h "$AGE_H" '. + [{agent:$n, age_h:($h|tonumber)}]')
    cortextos bus log-event action stale_verified warning \
      --meta "{\"agent\":\"$NAME\",\"age_h\":$AGE_H,\"running\":false}" >/dev/null 2>&1
  elif [[ "$FRESH_EVENTS" -gt 0 ]]; then
    DISMISSED=$(echo "$DISMISSED" | jq -c --arg n "$NAME" --arg h "$AGE_H" --arg e "$FRESH_EVENTS" '. + [{agent:$n, age_h:($h|tonumber), fresh_events:($e|tonumber)}]')
    cortextos bus log-event action stale_dismissed info \
      --meta "{\"agent\":\"$NAME\",\"age_h\":$AGE_H,\"running\":true,\"fresh_events\":$FRESH_EVENTS}" >/dev/null 2>&1
  else
    SUSPECT=$(echo "$SUSPECT" | jq -c --arg n "$NAME" --arg h "$AGE_H" '. + [{agent:$n, age_h:($h|tonumber)}]')
    cortextos bus log-event action stale_suspect info \
      --meta "{\"agent\":\"$NAME\",\"age_h\":$AGE_H,\"running\":true,\"fresh_events\":0}" >/dev/null 2>&1
  fi
done < <(echo "$AGENTS_JSON" | jq -c '.[]')

jq -n --argjson v "$VERIFIED" --argjson s "$SUSPECT" --argjson d "$DISMISSED" --arg c "$CHECKED" \
  '{verified:$v, suspect:$s, dismissed:$d, checked:($c|tonumber)}'
