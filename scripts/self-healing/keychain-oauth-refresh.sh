#!/usr/bin/env bash
# keychain-oauth-refresh.sh — Proactive OAuth token refresh for cortextOS agents.
#
# Problem: Claude Code stores OAuth credentials in the macOS Keychain.
# Access tokens expire (typically every 8-12 hours). Agent PTYs running in
# daemon context may not have Keychain access, so CLAUDE_CODE_OAUTH_TOKEN
# must be present in secrets.env as a fallback. Without proactive refresh,
# all agents crash with 401 when the token expires (167-crash incident, 2026-06-23).
#
# Fix: this script runs every 6 hours. It:
#   1. Reads the Keychain entry "Claude Code-credentials"
#   2. If token expires within 2h: refreshes via Anthropic OAuth endpoint
#      and writes new credentials back to Keychain
#   3. Always writes current accessToken to $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/secrets.env
#      as CLAUDE_CODE_OAUTH_TOKEN so agent PTYs have it via env var
#
# Driven by the keychain-oauth-refresh cron (every 6 hours).
# Cron fire must be recorded by the caller:
#   cortextos bus update-cron-fire keychain-oauth-refresh --interval 360

set -euo pipefail

SCRIPT="keychain-oauth-refresh"

log() { echo "[$SCRIPT] $*"; }
warn() { echo "[$SCRIPT] WARNING: $*" >&2; }

# --- Require macOS (Keychain is macOS-only) ---
if [ "$(uname)" != "Darwin" ]; then
  log "Non-macOS platform — SKIP (no Keychain). Ensure CLAUDE_CODE_OAUTH_TOKEN is set manually."
  exit 0
fi

# --- Resolve org secrets.env path ---
ORG="${CTX_ORG:-phytomedic}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-}"
if [ -z "$FRAMEWORK_ROOT" ]; then
  # Fall back to repo root (scripts/ lives in repo root)
  FRAMEWORK_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)" || {
    warn "CTX_FRAMEWORK_ROOT not set and git rev-parse failed — cannot locate secrets.env"
    exit 1
  }
fi

SECRETS_ENV="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"

# --- Read Keychain ---
CREDS_JSON=$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || true)
if [ -z "$CREDS_JSON" ]; then
  warn "No 'Claude Code-credentials' entry in Keychain. Run 'claude setup-token' first."
  exit 1
fi

# Extract fields
CREDS_DATA=$(echo "$CREDS_JSON" | python3 -c "
import json,sys,time
d = json.load(sys.stdin)
oat = d.get('claudeAiOauth', {})
acc = oat.get('accessToken', '')
ref = oat.get('refreshToken', '')
exp = oat.get('expiresAt', 0)
now_ms = int(time.time() * 1000)
ttl_s = int((exp - now_ms) / 1000)
print(f'ACCESS_TOKEN={acc}')
print(f'REFRESH_TOKEN={ref}')
print(f'EXPIRES_AT={exp}')
print(f'TTL_S={ttl_s}')
" 2>/dev/null)

eval "$CREDS_DATA"

if [ -z "${ACCESS_TOKEN:-}" ]; then
  warn "Could not extract accessToken from Keychain entry"
  exit 1
fi

log "Keychain token TTL: ${TTL_S}s ($(( TTL_S / 3600 ))h $(( (TTL_S % 3600) / 60 ))m)"

# --- Refresh if expiring within 2 hours (7200s) ---
REFRESH_THRESHOLD=7200
if [ "${TTL_S:-0}" -lt "$REFRESH_THRESHOLD" ]; then
  if [ -z "${REFRESH_TOKEN:-}" ]; then
    warn "Token expiring in ${TTL_S}s but no refreshToken available — cannot refresh"
  else
    log "Token expiring soon (${TTL_S}s < ${REFRESH_THRESHOLD}s). Refreshing via Anthropic endpoint..."

    REFRESH_RESPONSE=$(curl -s -m 30 -X POST \
      'https://console.anthropic.com/v1/oauth/token' \
      -H 'Content-Type: application/json' \
      -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"${REFRESH_TOKEN}\"}" 2>/dev/null || true)

    NEW_ACCESS=$(echo "$REFRESH_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null || true)
    NEW_REFRESH=$(echo "$REFRESH_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('refresh_token',''))" 2>/dev/null || true)
    EXPIRES_IN=$(echo "$REFRESH_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('expires_in',3600))" 2>/dev/null || echo 3600)

    if [ -z "$NEW_ACCESS" ]; then
      warn "Token refresh failed. Response: $REFRESH_RESPONSE"
      warn "Using current (expiring) token as fallback"
    else
      ACCESS_TOKEN="$NEW_ACCESS"
      NEW_EXPIRES_AT=$(( $(date +%s) * 1000 + EXPIRES_IN * 1000 ))

      # Write new credentials back to Keychain
      NEW_CREDS=$(echo "$CREDS_JSON" | python3 -c "
import json,sys
d = json.load(sys.stdin)
oat = d.get('claudeAiOauth', {})
oat['accessToken'] = '$NEW_ACCESS'
oat['refreshToken'] = '$NEW_REFRESH'
oat['expiresAt'] = $NEW_EXPIRES_AT
d['claudeAiOauth'] = oat
print(json.dumps(d))
" 2>/dev/null)

      if [ -n "$NEW_CREDS" ]; then
        # Delete old entry then add new one (security tool doesn't support in-place update of password)
        security delete-generic-password -s 'Claude Code-credentials' 2>/dev/null || true
        printf '%s' "$NEW_CREDS" | security add-generic-password \
          -s 'Claude Code-credentials' -a 'Claude Code' -w "$(cat)" 2>/dev/null && \
          log "Keychain updated with refreshed token (expires_in=${EXPIRES_IN}s)" || \
          warn "Keychain write failed (non-fatal — env var path still works)"
      fi

      log "Token refreshed successfully (expires_in=${EXPIRES_IN}s)"
    fi
  fi
else
  log "Token has ${TTL_S}s TTL — no refresh needed"
fi

# --- Write current token to secrets.env (always, so PTY env var is current) ---
if [ -f "$SECRETS_ENV" ]; then
  if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" "$SECRETS_ENV"; then
    python3 -c "
import re
content = open('$SECRETS_ENV').read()
content = re.sub(r'^CLAUDE_CODE_OAUTH_TOKEN=.*$', 'CLAUDE_CODE_OAUTH_TOKEN=$ACCESS_TOKEN', content, flags=re.M)
open('$SECRETS_ENV', 'w').write(content)
print('Updated CLAUDE_CODE_OAUTH_TOKEN in $SECRETS_ENV')
"
  else
    echo "CLAUDE_CODE_OAUTH_TOKEN=$ACCESS_TOKEN" >> "$SECRETS_ENV"
    log "Appended CLAUDE_CODE_OAUTH_TOKEN to $SECRETS_ENV"
  fi
else
  echo "CLAUDE_CODE_OAUTH_TOKEN=$ACCESS_TOKEN" > "$SECRETS_ENV"
  log "Created $SECRETS_ENV with CLAUDE_CODE_OAUTH_TOKEN"
fi

log "Done. secrets.env synced. TTL remaining: ${TTL_S}s"
