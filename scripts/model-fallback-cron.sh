#!/bin/bash
# Auto-fallback + auto-restore for cortextOS agent models.
#
# Logic:
#  - State file stores the "preferred" model (the one we want when everything is healthy).
#  - If current model in config.json is preferred AND recent JSONL shows ≥3 synthetic
#    auth/rate-limit errors → probe API, find the highest-tier model that returns 200,
#    write it to config.json, restart agent.
#  - If current model differs from preferred → probe preferred. If 200, restore it and
#    restart. (This is the "check if Opus is back" path.)
#
# Run every 10 min via LaunchAgent.

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
set -uo pipefail  # not -e: we want the script to continue past per-agent failures

LOG=/Users/hari/.cortextos/macbook/logs/cortextos/model-fallback.log
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

# Tier order: try to restore in this order; fall back in this order.
TIER_ORDER=("claude-opus-4-7" "claude-sonnet-4-6" "claude-haiku-4-5-20251001")

TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])' 2>/dev/null)
if [[ -z "${TOKEN:-}" ]]; then log "no token in keychain — abort"; exit 0; fi

# Probe a model. Returns 0 if HTTP 200, nonzero otherwise.
probe_model() {
  local m=$1
  local code
  code=$(curl -sS --max-time 8 -X POST https://api.anthropic.com/v1/messages \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "content-type: application/json" \
    -d "{\"model\":\"$m\",\"max_tokens\":3,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)
  [[ "$code" == "200" ]]
}

# Count recent synthetic auth/rate-limit responses in agent's JSONL.
recent_failures() {
  local agent=$1
  local dir="/Users/hari/.claude/projects/-Users-hari-cortextos-orgs-subbu-ops-agents-$agent"
  local jsonl
  jsonl=$(ls -t "$dir"/*.jsonl 2>/dev/null | grep -v poisoned | head -1)
  [[ -f "$jsonl" ]] || { echo 0; return; }
  python3 - "$jsonl" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    lines = [l for l in f if l.strip()]
count = 0
for ln in lines[-30:]:
    try:
        r = json.loads(ln)
        if r.get("type") == "assistant":
            m = r.get("message", {}) or {}
            if m.get("model") == "<synthetic>":
                content = m.get("content", [])
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "text":
                            t = b.get("text", "")
                            if "401" in t or "Not logged in" in t or "Please run /login" in t or "rate_limit" in t:
                                count += 1
                                break
    except: pass
print(count)
PY
}

# Determine the running instance (from PM2).
INSTANCE=$(pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    for a in d:
        if a.get("name") == "cortextos-daemon":
            print(a.get("pm2_env", {}).get("CTX_INSTANCE_ID", "default")); break
except: pass' 2>/dev/null)
INSTANCE=${INSTANCE:-default}

# Find every agent config and process it.
for config in /Users/hari/cortextos/orgs/*/agents/*/config.json; do
  agent=$(basename "$(dirname "$config")")
  state_dir="/Users/hari/.cortextos/$INSTANCE/state/$agent"
  preferred_file="$state_dir/.preferred-model"
  mkdir -p "$state_dir"

  current=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model",""))' "$config" 2>/dev/null)
  [[ -z "$current" ]] && continue

  # Seed preferred from current on first run.
  if [[ ! -f "$preferred_file" ]]; then
    echo "$current" > "$preferred_file"
    log "$agent: seeded preferred=$current"
  fi
  preferred=$(cat "$preferred_file")

  if [[ "$current" != "$preferred" ]]; then
    # In fallback. Check if preferred is back.
    if probe_model "$preferred"; then
      python3 - "$config" "$preferred" <<'PY'
import json, sys
p, m = sys.argv[1], sys.argv[2]
with open(p) as f: d = json.load(f)
d["model"] = m
with open(p, "w") as f: json.dump(d, f, indent=2)
PY
      /opt/homebrew/bin/cortextos restart "$agent" --instance "$INSTANCE" >> "$LOG" 2>&1
      log "$agent: RESTORED $current → $preferred"
    fi
  else
    # On preferred. Check failure rate.
    fails=$(recent_failures "$agent")
    if [[ "$fails" -ge 3 ]]; then
      # Try fallbacks below current tier.
      found_at=-1
      for i in "${!TIER_ORDER[@]}"; do
        [[ "${TIER_ORDER[$i]}" == "$current" ]] && found_at=$i
      done
      if [[ "$found_at" -ge 0 ]]; then
        for ((i=found_at+1; i<${#TIER_ORDER[@]}; i++)); do
          fallback="${TIER_ORDER[$i]}"
          if probe_model "$fallback"; then
            python3 - "$config" "$fallback" <<'PY'
import json, sys
p, m = sys.argv[1], sys.argv[2]
with open(p) as f: d = json.load(f)
d["model"] = m
with open(p, "w") as f: json.dump(d, f, indent=2)
PY
            touch "$state_dir/.force-fresh"
            /opt/homebrew/bin/cortextos restart "$agent" --instance "$INSTANCE" >> "$LOG" 2>&1
            log "$agent: FELL BACK $current → $fallback (fails=$fails, preferred=$preferred preserved)"
            break
          fi
        done
      fi
    fi
  fi
done
