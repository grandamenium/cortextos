#!/usr/bin/env bash
# core-service-health-check.sh — fleet-wide core-service watchdog.
#
# Checks the five services agents depend on to do any useful work:
#   1. KB          — kb-query round-trip under threshold, non-zero results
#   2. preview     — mint a URL and fetch it back (200); the mint and the serve
#                    are separate failure domains, so a round-trip is required
#   3. dashboard   — dashboard.profithits.app /api/v1/health
#   4. status      — status.profithits.app /api/strategies
#   5. bus         — cortextos bus check-inbox exits clean
#
# On ANY failure: alert chief (bus) + Chris (Telegram).
#
# Fleet rule: the SAME service failing twice within 24h is an incident, not a
# blip. Failures are stamped to STATE_FILE; the second stamp inside the window
# escalates the alert to INCIDENT and logs a distinct event so it can be filed.
#
# DRY_RUN=1 prints alerts instead of sending them.

set -uo pipefail

CORTEXTOS_BIN="${CORTEXTOS_BIN:-cortextos}"
ORG="${CTX_ORG:-prop-firm-admin}"
AGENT="${CTX_AGENT_NAME:-devops}"

BOT_TOKEN="8649138124:AAE2C5QfE2mSCgtHDo_ggveXKfmUvdA1hdo"
CHAT_ID="6585156851"
DRY_RUN="${DRY_RUN:-0}"

STATE_FILE="${CORE_HEALTH_STATE:-$HOME/.cortextos/state/core-service-failures.tsv}"
INCIDENT_WINDOW_SECS=86400

# See kb-health-check.sh for why this is 25s and not 10s.
KB_THRESHOLD_MS="${KB_HEALTH_THRESHOLD_MS:-25000}"
KB_CONTROL_QUERY="${KB_CONTROL_QUERY:-market open flip strategy}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-15}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

CT_TIME=$(TZ=America/Chicago date '+%-I:%M %p CT')
NOW_EPOCH=$(date +%s)

FAILED_NAMES=()
FAILED_DETAILS=()
INCIDENT_NAMES=()

send_telegram() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[core-health] DRY_RUN telegram:\n%s\n' "$1"
    return
  fi
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
}

notify_chief() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[core-health] DRY_RUN chief message:\n%s\n' "$1"
    return
  fi
  "$CORTEXTOS_BIN" bus send-message chief high "$1" >/dev/null 2>&1 || true
}

# Record a failure and report whether it is a repeat inside the 24h window.
# Prunes stamps older than the window so the file cannot grow without bound.
record_failure() {
  local service="$1" cutoff prior
  cutoff=$(( NOW_EPOCH - INCIDENT_WINDOW_SECS ))

  prior=$(awk -v s="$service" -v c="$cutoff" '$1==s && $2>c' "$STATE_FILE" 2>/dev/null | wc -l)

  local tmp="${STATE_FILE}.tmp.$$"
  awk -v c="$cutoff" '$2>c' "$STATE_FILE" > "$tmp" 2>/dev/null || : > "$tmp"
  printf '%s\t%s\n' "$service" "$NOW_EPOCH" >> "$tmp"
  mv "$tmp" "$STATE_FILE"

  [[ "$prior" -ge 1 ]] && return 0
  return 1
}

fail() {
  local service="$1" detail="$2"
  echo "[core-health] FAIL ${service}: ${detail}"
  FAILED_NAMES+=("$service")
  FAILED_DETAILS+=("${service}: ${detail}")
  if record_failure "$service"; then
    INCIDENT_NAMES+=("$service")
  fi
}

ok() { echo "[core-health] OK   $1: $2"; }

# --- 1. knowledge base -----------------------------------------------------
KB_START=$(date +%s%N)
KB_OUT=$("$CORTEXTOS_BIN" bus kb-query "$KB_CONTROL_QUERY" \
  --org "$ORG" --agent "$AGENT" --scope shared 2>&1)
KB_EXIT=$?
KB_MS=$(( ($(date +%s%N) - KB_START) / 1000000 ))
KB_RESULTS=$(printf '%s' "$KB_OUT" | sed -n 's/.*Knowledge Base Results (\([0-9]*\)\/.*/\1/p' | head -1)
[[ -z "$KB_RESULTS" ]] && KB_RESULTS=0

if [[ $KB_EXIT -ne 0 ]]; then
  fail "kb" "kb-query exited ${KB_EXIT} after ${KB_MS}ms — $(printf '%s' "$KB_OUT" | tail -2 | tr '\n' ' ' | cut -c1-200)"
elif [[ "$KB_RESULTS" -eq 0 ]]; then
  fail "kb" "control query returned 0 results (index empty or unreadable)"
elif [[ $KB_MS -gt $KB_THRESHOLD_MS ]]; then
  fail "kb" "latency ${KB_MS}ms over ${KB_THRESHOLD_MS}ms"
else
  ok "kb" "${KB_MS}ms, ${KB_RESULTS} results"
fi

# --- 2. preview-server mint + fetch round-trip -----------------------------
PROBE_DIR="/mnt/r2/files/healthcheck"
PROBE_REL="healthcheck/probe.txt"
MINT_SCRIPT="/home/claude-dev/preview-server/scripts/mint-preview-url.sh"

if [[ ! -x "$MINT_SCRIPT" ]]; then
  fail "preview" "mint script missing or not executable: ${MINT_SCRIPT}"
else
  mkdir -p "$PROBE_DIR" 2>/dev/null
  # Rewrite the probe each run so a stale-but-served file cannot mask a broken
  # write path.
  echo "core-service-health-check probe ${NOW_EPOCH}" > "${PROBE_DIR}/probe.txt" 2>/dev/null
  MINT_OUT=$("$MINT_SCRIPT" "$PROBE_REL" 2>&1)
  PREVIEW_URL=$(printf '%s' "$MINT_OUT" | grep -oE 'https://[^ ]+' | head -1)
  if [[ -z "$PREVIEW_URL" ]]; then
    fail "preview" "mint produced no URL — $(printf '%s' "$MINT_OUT" | tail -2 | tr '\n' ' ' | cut -c1-200)"
  else
    PREVIEW_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$PREVIEW_URL")
    if [[ "$PREVIEW_CODE" != "200" ]]; then
      fail "preview" "minted URL returned HTTP ${PREVIEW_CODE}"
    else
      ok "preview" "mint+fetch 200"
    fi
  fi
fi

# --- 3/4. HTTP endpoints ---------------------------------------------------
check_http() {
  local name="$1" url="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$url")
  if [[ "$code" != "200" ]]; then
    fail "$name" "HTTP ${code} from ${url}"
  else
    ok "$name" "HTTP 200"
  fi
}

check_http "dashboard" "https://dashboard.profithits.app/api/v1/health"
check_http "status" "https://status.profithits.app/api/strategies"
check_http "files" "https://files.profithits.app/health"

# --- 5. bus ----------------------------------------------------------------
if BUS_OUT=$(timeout 30 "$CORTEXTOS_BIN" bus check-inbox 2>&1); then
  ok "bus" "check-inbox clean"
else
  fail "bus" "check-inbox exited $? — $(printf '%s' "$BUS_OUT" | tail -2 | tr '\n' ' ' | cut -c1-200)"
fi

# --- report ----------------------------------------------------------------
if [[ ${#FAILED_NAMES[@]} -eq 0 ]]; then
  echo "[core-health] ALL OK (6/6)"
  "$CORTEXTOS_BIN" bus log-event action core_service_health_ok info \
    --meta "$(printf '{"kb_latency_ms":%s,"kb_results":%s,"checked":6}' "$KB_MS" "$KB_RESULTS")" \
    2>/dev/null || true
  exit 0
fi

FAILED_CSV=$(IFS=,; echo "${FAILED_NAMES[*]}")
DETAIL_BLOCK=$(printf '%s\n' "${FAILED_DETAILS[@]}")

SEVERITY="error"
HEADER="🔴 Core service check FAILED — ${CT_TIME} (${#FAILED_NAMES[@]}/6)"
INCIDENT_LINE=""
if [[ ${#INCIDENT_NAMES[@]} -gt 0 ]]; then
  SEVERITY="critical"
  INCIDENT_CSV=$(IFS=,; echo "${INCIDENT_NAMES[*]}")
  HEADER="🚨 INCIDENT — core service failed twice in 24h — ${CT_TIME}"
  INCIDENT_LINE="
Incident (2nd failure in 24h): ${INCIDENT_CSV}
Fleet rule → file an incident for the above."
  "$CORTEXTOS_BIN" bus log-event error core_service_incident critical \
    --meta "$(printf '{"services":"%s","window_hours":24}' "$INCIDENT_CSV")" 2>/dev/null || true
fi

"$CORTEXTOS_BIN" bus log-event error core_service_degraded "$SEVERITY" \
  --meta "$(printf '{"failed":"%s","failed_count":%s}' "$FAILED_CSV" "${#FAILED_NAMES[@]}")" \
  2>/dev/null || true

ALERT="${HEADER}

Failed ${#FAILED_NAMES[@]}/5: ${FAILED_CSV}
${DETAIL_BLOCK}${INCIDENT_LINE}"

send_telegram "$ALERT"
notify_chief "core-service-health: FAILED=${FAILED_CSV}${INCIDENT_NAMES[*]:+ INCIDENT=$(IFS=,; echo "${INCIDENT_NAMES[*]}")} — ${DETAIL_BLOCK//$'\n'/ | }"

exit 1
