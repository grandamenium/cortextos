#!/bin/bash
# Auto-refresh CLAUDE_CODE_OAUTH_TOKEN in cortextos agent .env files from the
# macOS keychain. Run hourly via LaunchAgent. Restarts agents whose token
# actually changed; no-op when token is unchanged.
#
# PATH override: launchd's default PATH excludes /opt/homebrew/bin where pm2,
# cortextos, and python3 (under brew) live. Without this, `set -e + pipefail`
# aborts on the first unfound command and the agent exits 127.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
set -euo pipefail
LOG_BASE=/Users/hari/.cortextos
mkdir -p "$LOG_BASE/macbook/logs/cortextos" 2>/dev/null || true
LOG="$LOG_BASE/macbook/logs/cortextos/token-refresh.log"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG" 2>/dev/null; }
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])' 2>/dev/null) || { log "could not read keychain token"; exit 0; }
[[ -z "$TOKEN" ]] && { log "empty token"; exit 0; }
# Discover which instance the daemon is currently on (so we restart on the right one).
INSTANCE=$(pm2 jlist 2>/dev/null | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    for a in d:
        if a.get("name")=="cortextos-daemon":
            print(a.get("pm2_env",{}).get("CTX_INSTANCE_ID","default"))
            break
except: pass' 2>/dev/null)
INSTANCE=${INSTANCE:-default}
for env_file in /Users/hari/cortextos/orgs/*/agents/*/.env; do
  [[ -f "$env_file" ]] || continue
  if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" "$env_file"; then
    OLD=$(grep "^CLAUDE_CODE_OAUTH_TOKEN=" "$env_file" | head -1 | cut -d= -f2-)
    if [[ "$OLD" != "$TOKEN" ]]; then
      awk -v tok="$TOKEN" '/^CLAUDE_CODE_OAUTH_TOKEN=/{print "CLAUDE_CODE_OAUTH_TOKEN="tok; next} {print}' "$env_file" > "$env_file.new" && mv "$env_file.new" "$env_file"
      AGENT=$(basename "$(dirname "$env_file")")
      log "refreshed token in $env_file (agent: $AGENT, instance: $INSTANCE)"
      /opt/homebrew/bin/cortextos restart "$AGENT" --instance "$INSTANCE" >> "$LOG" 2>&1 || log "restart of $AGENT on $INSTANCE failed"
    fi
  fi
done
