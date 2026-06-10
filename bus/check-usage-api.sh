#!/usr/bin/env bash
# Check Claude Max and Codex plan usage.
# Claude Max: reads OAuth token from macOS Keychain, calls the undocumented
# api.anthropic.com/api/oauth/usage endpoint.
# Codex: reads ~/.codex/auth.json, refreshes OAuth token if needed, then calls
# chatgpt.com/backend-api/wham/usage to get real used_percent for 5h and 7d windows.
#
# Usage:
#   cortextos bus check-usage-api [--warn-7day N] [--warn-5h N] [--chat-id ID]
#
# Options:
#   --warn-7day N   Warn (via Telegram) if 7-day utilization >= N% (default: 80)
#   --warn-5h N     Warn (via Telegram) if 5-hour utilization >= N% (default: 90)
#   --chat-id ID    Telegram chat ID to send alerts to (uses CTX_TELEGRAM_CHAT_ID if omitted)
#   --force         Bypass the 3-minute result cache
#
# Output: JSON with utilization fields + codex plan info, or exits 1 on error.
#
# Cache: Claude Max results are cached for 3 minutes at $CTX_ROOT/state/usage/api-cache.json
# to avoid hitting the hard rate limit (~5 requests per token before 429).
# Codex wham/usage is cached for 5 minutes at $CTX_ROOT/state/usage/codex-wham-cache.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_ctx-env.sh"

# ── Defaults ────────────────────────────────────────────────────────────────
WARN_7DAY=80
WARN_5H=90
CHAT_ID="${CTX_TELEGRAM_CHAT_ID:-}"
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --warn-7day) WARN_7DAY="$2"; shift 2 ;;
    --warn-5h)   WARN_5H="$2";   shift 2 ;;
    --chat-id)   CHAT_ID="$2";   shift 2 ;;
    --force)     FORCE=true;     shift   ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Source agent .env for CHAT_ID if not set ────────────────────────────────
if [[ -z "${CHAT_ID}" ]]; then
  ctx_source_env
  CHAT_ID="${CTX_TELEGRAM_CHAT_ID:-}"
fi

# ── Codex wham/usage API: returns live used_percent for 5h and 7d windows ────
_codex_wham_usage() {
  local auth_file="$HOME/.codex/auth.json"
  local cache_file="${CTX_ROOT}/state/usage/codex-wham-cache.json"
  local cache_ttl=300  # 5 minutes

  [[ -f "$auth_file" ]] || return 1

  # Return cached result if fresh
  if [[ "$FORCE" == "false" && -f "$cache_file" ]]; then
    local age=$(( $(date +%s) - $(date -r "$cache_file" +%s 2>/dev/null || echo 0) ))
    if [[ $age -lt $cache_ttl ]]; then
      cat "$cache_file"
      return 0
    fi
  fi

  # Get a valid access token (use existing if not expired, refresh otherwise)
  local access_token
  access_token=$(python3 -c "
import json, base64, time
try:
    auth = json.load(open('$auth_file'))
    token = auth.get('tokens', {}).get('access_token', '')
    seg = token.split('.')[1]
    seg += '=' * (4 - len(seg) % 4)
    payload = json.loads(base64.b64decode(seg))
    if payload.get('exp', 0) - time.time() > 300:
        print(token)
    else:
        print('')
except:
    print('')
" 2>/dev/null)

  if [[ -z "$access_token" ]]; then
    local refresh_token
    refresh_token=$(python3 -c "
import json
try:
    auth = json.load(open('$auth_file'))
    print(auth.get('tokens', {}).get('refresh_token', ''))
except:
    print('')
" 2>/dev/null)
    [[ -z "$refresh_token" ]] && return 1
    access_token=$(curl -sf "https://auth.openai.com/oauth/token" \
      -X POST -H "Content-Type: application/json" \
      -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$refresh_token\",\"client_id\":\"app_EMoamEEZ73f0CkXaXp7hrann\"}" \
      --max-time 10 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
    [[ -z "$access_token" ]] && return 1
  fi

  local result
  result=$(curl -sf "https://chatgpt.com/backend-api/wham/usage" \
    -H "Authorization: Bearer $access_token" \
    -H "Accept: application/json" \
    -H "User-Agent: OpenAI-Codex/1.0" \
    --max-time 10 2>/dev/null) || return 1

  echo "$result" > "$cache_file"
  echo "$result"
}

# ── Codex plan helper (JWT decode + wham/usage live % + SQLite token counts) ──
_codex_json() {
  local auth_file="$HOME/.codex/auth.json"
  local db_file="$HOME/.codex/logs_2.sqlite"
  [[ -f "$auth_file" ]] || { echo '{"error":"~/.codex/auth.json not found"}'; return; }

  local wham_json=""
  wham_json=$(_codex_wham_usage 2>/dev/null) || true

  CODEX_AUTH="$auth_file" CODEX_DB="$db_file" WHAM_JSON="$wham_json" python3 -c "
import json, base64, time, os, re, sqlite3
from datetime import datetime, timezone

result = {}

# JWT decode: plan type + token expiry
try:
    auth = json.load(open(os.environ['CODEX_AUTH']))
    token = auth.get('tokens', {}).get('access_token', '')
    seg = token.split('.')[1]
    seg += '=' * (4 - len(seg) % 4)
    payload = json.loads(base64.b64decode(seg))
    claims = payload.get('https://api.openai.com/auth', {})
    result['plan_type'] = claims.get('chatgpt_plan_type', 'unknown')
    result['token_expires_in_hours'] = round((payload.get('exp', 0) - time.time()) / 3600, 1)
except Exception as e:
    result['plan_type'] = 'unknown'
    result['token_expires_in_hours'] = None
    result['jwt_error'] = str(e)

# Live usage % from wham/usage API
wham_raw = os.environ.get('WHAM_JSON', '')
if wham_raw:
    try:
        wham = json.loads(wham_raw)
        rl = wham.get('rate_limit', {})
        pw = rl.get('primary_window', {})
        sw = rl.get('secondary_window', {})
        result['utilization_5h']  = pw.get('used_percent')
        result['utilization_7d']  = sw.get('used_percent')
        result['reset_5h_seconds'] = pw.get('reset_after_seconds')
        result['reset_7d_seconds'] = sw.get('reset_after_seconds')
        result['limit_reached']   = rl.get('limit_reached', False)
        result['allowed']         = rl.get('allowed', True)
    except Exception:
        pass

# SQLite usage: aggregate token counts from recent turns
db_path = os.environ.get('CODEX_DB', '')
if db_path and os.path.exists(db_path):
    try:
        conn = sqlite3.connect(db_path)
        now = int(time.time())
        cutoff_5h  = now - 18000
        cutoff_24h = now - 86400

        rows = conn.execute(
            'SELECT ts, feedback_log_body FROM logs WHERE feedback_log_body LIKE ? AND ts > ? ORDER BY ts DESC LIMIT 500',
            ('%codex.turn.token_usage.total_tokens%', cutoff_24h)
        ).fetchall()

        tokens_5h = 0
        tokens_24h = 0
        models_5h = {}

        for ts, body in rows:
            m_total = re.search(r'token_usage\.total_tokens=(\d+)', body)
            m_model = re.search(r'model=([^\s\}]+)', body)
            if not m_total:
                continue
            total = int(m_total.group(1))
            model = m_model.group(1) if m_model else 'unknown'
            tokens_24h += total
            if ts > cutoff_5h:
                tokens_5h += total
                models_5h[model] = models_5h.get(model, 0) + total

        result['tokens_5h']  = tokens_5h
        result['tokens_24h'] = tokens_24h
        result['models_5h']  = models_5h
        conn.close()
    except Exception as e:
        result['usage_error'] = str(e)

print(json.dumps(result))
" 2>/dev/null || echo '{"error":"codex data fetch failed"}'
}

_merge_codex() {
  local resp="$1"
  local codex
  codex=$(_codex_json)
  RESP_JSON="$resp" CODEX_JSON="$codex" python3 -c "
import json, os
d = json.loads(os.environ['RESP_JSON'])
d['codex'] = json.loads(os.environ['CODEX_JSON'])
print(json.dumps(d))
" 2>/dev/null || echo "$resp"
}

# ── Cache check ─────────────────────────────────────────────────────────────
CACHE_DIR="${CTX_ROOT}/state/usage"
CACHE_FILE="${CACHE_DIR}/api-cache.json"
CACHE_TTL=180  # 3 minutes

mkdir -p "$CACHE_DIR"

if [[ "$FORCE" == "false" && -f "$CACHE_FILE" ]]; then
  cache_age=$(( $(date +%s) - $(date -r "$CACHE_FILE" +%s 2>/dev/null || echo 0) ))
  if [[ $cache_age -lt $CACHE_TTL ]]; then
    _merge_codex "$(cat "$CACHE_FILE")"
    exit 0
  fi
fi

# ── Read OAuth token from Keychain ──────────────────────────────────────────
if ! command -v security &>/dev/null; then
  echo '{"error":"macOS Keychain (security) not available"}' >&2
  exit 1
fi

RAW_CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
if [[ -z "$RAW_CREDS" ]]; then
  echo '{"error":"Claude Code credentials not found in Keychain"}' >&2
  exit 1
fi

ACCESS_TOKEN=$(echo "$RAW_CREDS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['claudeAiOauth']['accessToken'])
except Exception as e:
    sys.stderr.write(str(e) + '\n')
    sys.exit(1)
" 2>/dev/null || true)

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo '{"error":"Could not parse access token from Keychain credentials"}' >&2
  exit 1
fi

# ── Call usage API ───────────────────────────────────────────────────────────
RESPONSE=$(curl -sf "https://api.anthropic.com/api/oauth/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "anthropic-beta: oauth-2025-04-20" \
  --max-time 10 2>/dev/null || true)

if [[ -z "$RESPONSE" ]]; then
  echo '{"error":"Usage API request failed or timed out"}' >&2
  exit 1
fi

# Validate it's JSON with expected fields
if ! echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'five_hour' in d or 'seven_day' in d" 2>/dev/null; then
  echo "{\"error\":\"Unexpected API response\",\"raw\":$(echo "$RESPONSE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')}" >&2
  exit 1
fi

# Cache the result
echo "$RESPONSE" > "$CACHE_FILE"

# ── Threshold checks + Telegram alerts ──────────────────────────────────────
ALERT_SENT=false

if [[ -n "$CHAT_ID" ]]; then
  FIVE_H=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('five_hour',{}).get('utilization'); print(v if v is not None else -1)" 2>/dev/null || echo -1)
  SEVEN_D=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('seven_day',{}).get('utilization'); print(v if v is not None else -1)" 2>/dev/null || echo -1)
  SEVEN_D_RESET=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('seven_day',{}).get('resets_at','unknown'))" 2>/dev/null || echo "unknown")
  FIVE_H_RESET=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('five_hour',{}).get('resets_at','unknown'))" 2>/dev/null || echo "unknown")

  # 7-day critical threshold
  if python3 -c "import sys; v=float('${SEVEN_D}'); sys.exit(0 if v >= ${WARN_7DAY} else 1)" 2>/dev/null; then
    SEND_MSG="CODE RED: Claude Max 7-day usage at ${SEVEN_D}%. Resets: ${SEVEN_D_RESET}. Agents will hit hard limit soon. Action needed: reduce agent frequency or pause non-critical crons."
    # Use send-telegram if available
    if [[ -f "$SCRIPT_DIR/send-telegram.sh" ]]; then
      bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    fi
    ALERT_SENT=true
    echo "$SEND_MSG" >&2
  fi

  # 5-hour warning threshold
  if python3 -c "import sys; v=float('${FIVE_H}'); sys.exit(0 if v >= ${WARN_5H} else 1)" 2>/dev/null; then
    SEND_MSG="Warning: Claude Max 5-hour window at ${FIVE_H}%. Resets: ${FIVE_H_RESET}."
    if [[ -f "$SCRIPT_DIR/send-telegram.sh" ]]; then
      bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    fi
    echo "$SEND_MSG" >&2
  fi

  # Codex token expiry warning (< 24h)
  CODEX_EXPIRES=$(CODEX_AUTH="$HOME/.codex/auth.json" python3 -c "
import json, base64, time, os
try:
    auth = json.load(open(os.environ['CODEX_AUTH']))
    token = auth.get('tokens', {}).get('access_token', '')
    seg = token.split('.')[1] + '=='
    payload = json.loads(base64.b64decode(seg))
    print(round((payload.get('exp', 0) - time.time()) / 3600, 1))
except: print(9999)
" 2>/dev/null || echo 9999)
  if python3 -c "import sys; sys.exit(0 if float('${CODEX_EXPIRES}') < 24 else 1)" 2>/dev/null; then
    SEND_MSG="Warning: Codex OAuth token expires in ${CODEX_EXPIRES}h. Run Codex and re-authenticate."
    if [[ -f "$SCRIPT_DIR/send-telegram.sh" ]]; then
      bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    fi
    echo "$SEND_MSG" >&2
  fi

  # Codex usage threshold checks (from wham/usage)
  CODEX_WHAM=$(_codex_wham_usage 2>/dev/null || echo "")
  if [[ -n "$CODEX_WHAM" ]]; then
    CODEX_5H=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('primary_window',{}).get('used_percent',-1))" 2>/dev/null || echo -1)
    CODEX_7D=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('secondary_window',{}).get('used_percent',-1))" 2>/dev/null || echo -1)
    CODEX_LIMIT=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('limit_reached',False))" 2>/dev/null || echo "False")

    if [[ "$CODEX_LIMIT" == "True" ]]; then
      SEND_MSG="CODE RED: Codex rate limit reached. Sessions blocked until window resets."
      [[ -f "$SCRIPT_DIR/send-telegram.sh" ]] && bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    elif python3 -c "import sys; v=float('${CODEX_7D}'); sys.exit(0 if v >= ${WARN_7DAY} else 1)" 2>/dev/null; then
      SEND_MSG="Warning: Codex 7-day usage at ${CODEX_7D}%."
      [[ -f "$SCRIPT_DIR/send-telegram.sh" ]] && bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    elif python3 -c "import sys; v=float('${CODEX_5H}'); sys.exit(0 if v >= ${WARN_5H} else 1)" 2>/dev/null; then
      SEND_MSG="Warning: Codex 5-hour window at ${CODEX_5H}%."
      [[ -f "$SCRIPT_DIR/send-telegram.sh" ]] && bash "$SCRIPT_DIR/send-telegram.sh" "$CHAT_ID" "$SEND_MSG" 2>/dev/null || true
    fi
  fi
fi

# ── Output (Claude Max + Codex merged) ───────────────────────────────────────
_merge_codex "$RESPONSE"
