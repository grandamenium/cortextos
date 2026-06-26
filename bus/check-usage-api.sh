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
# Alert behavior (env-configurable):
#   Each condition fires AT MOST ONCE per distinct state value and re-arms only
#   when that value changes, so an unchanged condition is not re-sent every cron
#   tick. During the quiet band NO Telegram is sent for ANY condition (no
#   critical carve-out); suppressed alerts are appended to a state file for
#   paul's heartbeat to surface, and are DROPPED (not re-sent) when the band ends.
#     CTX_USAGE_QUIET_START_HOUR  Quiet-band start, inclusive UTC hour (default 20)
#     CTX_USAGE_QUIET_END_HOUR    Quiet-band end, exclusive UTC hour   (default 5)
#     CTX_USAGE_SUPPRESSED_LOG    Suppressed-alert log path
#                                 (default $CTX_ROOT/state/usage/suppressed-alerts.jsonl)
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

# ── Alert dedup + quiet-band (per-condition fire-once + re-arm) ──────────────
# Each alert condition fires AT MOST ONCE per distinct state value and re-arms
# only when that value changes (e.g. codex-expiry:<expiry-ISO-hour> re-arms when
# a re-auth produces a new expiry; threshold alerts key on resets_at so they fire
# once per window). This kills the every-2h re-send of an unchanged condition.
#
# Quiet band (default 20:00-05:00Z): NO James-facing Telegram is sent for ANY
# condition, with NO critical carve-out — this script must never decide to wake
# James overnight (an overnight emergency is paul's call, not a bash threshold).
# Suppressed alerts are appended to a state file (ts + condition + value +
# message) so paul's heartbeat can surface them as a card; the signal is
# preserved, not lost. catch-up = DROP: a suppressed alert is NOT re-sent when
# the band ends (the marker is advanced so the unchanged condition stays quiet).
# Window + suppressed-log path are config-driven via env.
QUIET_START="${CTX_USAGE_QUIET_START_HOUR:-20}"   # inclusive UTC hour
QUIET_END="${CTX_USAGE_QUIET_END_HOUR:-5}"        # exclusive UTC hour
MARKER_DIR="${CTX_ROOT}/state/usage/alert-markers"
SUPPRESSED_LOG="${CTX_USAGE_SUPPRESSED_LOG:-${CTX_ROOT}/state/usage/suppressed-alerts.jsonl}"
mkdir -p "$MARKER_DIR" "$(dirname "$SUPPRESSED_LOG")"

_in_quiet_band() {
  local h; h=$((10#$(date -u +%H)))
  if [[ $QUIET_START -le $QUIET_END ]]; then
    [[ $h -ge $QUIET_START && $h -lt $QUIET_END ]]
  else
    # window wraps midnight (e.g. 20..05)
    [[ $h -ge $QUIET_START || $h -lt $QUIET_END ]]
  fi
}

# Framework CLI (../dist/cli.js, the same path the bus wrapper scripts resolve).
# All James-facing sends go through paul over the bus — this script NEVER calls
# Telegram directly (standing fleet rule: paul is the sole James-facing Telegram
# surface and relays alerts with his own judgment).
CLI="${SCRIPT_DIR}/../dist/cli.js"

# _alert <condition> <state-value> <message> [priority]
# Sends iff: state-value differs from the last-handled value for this condition
# (fire-once + re-arm) AND we are outside the quiet band. Open band routes the
# alert to paul over the bus (priority high for CODE RED conditions, normal
# otherwise). In-band firings are recorded to the suppressed log ONLY (no bus
# message) and the marker is advanced (catch-up = DROP); paul's heartbeat
# cursor-reads the log into the morning card.
_alert() {
  local cond="$1" val="$2" msg="$3" priority="${4:-normal}"
  local marker="$MARKER_DIR/${cond}"
  if [[ -f "$marker" && "$(cat "$marker" 2>/dev/null)" == "$val" ]]; then
    return 0  # already handled for this exact state value
  fi
  if _in_quiet_band; then
    printf '{"ts":"%s","condition":"%s","value":"%s","message":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cond" "$val" \
      "$(printf '%s' "$msg" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
      >> "$SUPPRESSED_LOG"
    echo "$val" > "$marker"  # advance marker: DROP, do not re-send post-band
    echo "[quiet-band suppressed] ${cond}: ${msg}" >&2
    return 0
  fi
  # Open band: route through paul over the bus (never direct Telegram).
  node "$CLI" bus send-message paul "$priority" "USAGE-ALERT ${cond}: ${msg}" >/dev/null 2>&1 || true
  echo "$val" > "$marker"
  ALERT_SENT=true
  echo "$msg" >&2
}

# ── Threshold checks + Telegram alerts ──────────────────────────────────────
ALERT_SENT=false

if [[ -n "$CHAT_ID" ]]; then
  FIVE_H=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('five_hour',{}).get('utilization'); print(v if v is not None else -1)" 2>/dev/null || echo -1)
  SEVEN_D=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('seven_day',{}).get('utilization'); print(v if v is not None else -1)" 2>/dev/null || echo -1)
  SEVEN_D_RESET=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('seven_day',{}).get('resets_at','unknown'))" 2>/dev/null || echo "unknown")
  FIVE_H_RESET=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('five_hour',{}).get('resets_at','unknown'))" 2>/dev/null || echo "unknown")

  # Codex fields appended to EVERY alert payload (James directive 2026-05-30:
  # every James-facing usage alert must carry Codex plan + tokens_5h + tokens_24h
  # + token expiry as fields — never implemented in this script until now, the
  # threshold alerts were Claude-only). Computed once from the merged codex.*
  # data; token counts humanized (e.g. 4.9M). Codex expiry now lives ONLY as a
  # field — the standalone codex-OAuth-expiry alert class was the overnight spam
  # and is dropped (zero dedup value once expiry rides on every alert).
  CODEX_JSON="$(_codex_json)"
  CODEX_FIELDS="$(CODEX_JSON="$CODEX_JSON" python3 -c '
import os, json
try:
    c = json.loads(os.environ["CODEX_JSON"])
except Exception:
    c = {}
def comp(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit, div in (("M", 1e6), ("K", 1e3)):
        if abs(n) >= div:
            return f"{n/div:.1f}{unit}"
    return str(int(n))
plan = c.get("plan_type", "unknown")
exp = c.get("token_expires_in_hours")
exp_s = f"{exp}h" if exp is not None else "?"
t5h = comp(c.get("tokens_5h"))
t24h = comp(c.get("tokens_24h"))
print(f" | Codex: plan={plan}, 5h={t5h}tok, 24h={t24h}tok, token expires={exp_s}")
' 2>/dev/null || echo "")"

  # 7-day critical threshold (re-arms per 7d window via resets_at)
  if python3 -c "import sys; v=float('${SEVEN_D}'); sys.exit(0 if v >= ${WARN_7DAY} else 1)" 2>/dev/null; then
    SEND_MSG="CODE RED: Claude Max 7-day usage at ${SEVEN_D}%. Resets: ${SEVEN_D_RESET}. Agents will hit hard limit soon. Action needed: reduce agent frequency or pause non-critical crons.${CODEX_FIELDS}"
    _alert "claude-7d" "${SEVEN_D_RESET}" "$SEND_MSG" high
  fi

  # 5-hour warning threshold (re-arms per 5h window via resets_at)
  if python3 -c "import sys; v=float('${FIVE_H}'); sys.exit(0 if v >= ${WARN_5H} else 1)" 2>/dev/null; then
    SEND_MSG="Warning: Claude Max 5-hour window at ${FIVE_H}%. Resets: ${FIVE_H_RESET}.${CODEX_FIELDS}"
    _alert "claude-5h" "${FIVE_H_RESET}" "$SEND_MSG" normal
  fi

  # (Standalone codex-OAuth-expiry alert removed — it was the overnight spam;
  # token expiry now rides as a field on every alert via ${CODEX_FIELDS}.)

  # Codex usage threshold checks (from wham/usage)
  CODEX_WHAM=$(_codex_wham_usage 2>/dev/null || echo "")
  if [[ -n "$CODEX_WHAM" ]]; then
    CODEX_5H=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('primary_window',{}).get('used_percent',-1))" 2>/dev/null || echo -1)
    CODEX_7D=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('secondary_window',{}).get('used_percent',-1))" 2>/dev/null || echo -1)
    CODEX_LIMIT=$(echo "$CODEX_WHAM" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rate_limit',{}).get('limit_reached',False))" 2>/dev/null || echo "False")
    # Absolute reset hours (now + reset_after_seconds, truncated to the hour) are
    # stable within a window, so they key the per-window fire-once dedup.
    CODEX_5H_RESET=$(echo "$CODEX_WHAM" | python3 -c "
import sys,json,time
from datetime import datetime, timezone
try:
    d=json.load(sys.stdin); s=d.get('rate_limit',{}).get('primary_window',{}).get('reset_after_seconds')
    print(datetime.fromtimestamp(time.time()+s, tz=timezone.utc).strftime('%Y-%m-%dT%H') if s is not None else 'none')
except: print('none')
" 2>/dev/null || echo none)
    CODEX_7D_RESET=$(echo "$CODEX_WHAM" | python3 -c "
import sys,json,time
from datetime import datetime, timezone
try:
    d=json.load(sys.stdin); s=d.get('rate_limit',{}).get('secondary_window',{}).get('reset_after_seconds')
    print(datetime.fromtimestamp(time.time()+s, tz=timezone.utc).strftime('%Y-%m-%dT%H') if s is not None else 'none')
except: print('none')
" 2>/dev/null || echo none)

    if [[ "$CODEX_LIMIT" == "True" ]]; then
      SEND_MSG="CODE RED: Codex rate limit reached. Sessions blocked until window resets.${CODEX_FIELDS}"
      _alert "codex-limit" "${CODEX_5H_RESET}" "$SEND_MSG" high
    elif python3 -c "import sys; v=float('${CODEX_7D}'); sys.exit(0 if v >= ${WARN_7DAY} else 1)" 2>/dev/null; then
      SEND_MSG="Warning: Codex 7-day usage at ${CODEX_7D}%.${CODEX_FIELDS}"
      _alert "codex-7d" "${CODEX_7D_RESET}" "$SEND_MSG" normal
    elif python3 -c "import sys; v=float('${CODEX_5H}'); sys.exit(0 if v >= ${WARN_5H} else 1)" 2>/dev/null; then
      SEND_MSG="Warning: Codex 5-hour window at ${CODEX_5H}%.${CODEX_FIELDS}"
      _alert "codex-5h" "${CODEX_5H_RESET}" "$SEND_MSG" normal
    fi
  fi
fi

# ── Output (Claude Max + Codex merged) ───────────────────────────────────────
_merge_codex "$RESPONSE"
