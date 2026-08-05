#!/usr/bin/env bash
# kb-health-check.sh — Knowledge-base latency watchdog.
#
# Times a real kb-query round-trip. The KB failure mode this guards against is
# NOT "returns an error" — it is "returns a confident empty result slowly".
# For a week kb-query stalled ~60s and printed "No results found", which is
# indistinguishable from a genuine miss, so nobody noticed the KB was down.
#
# This check therefore alerts on THREE conditions:
#   1. non-zero exit (kb-query now exits 1 on ETIMEDOUT — see src/bus/knowledge-base.ts)
#   2. latency over THRESHOLD_MS (degrading before it fails outright)
#   3. zero results for a control query that is known to match the corpus
#
# (3) is the important one: it catches a silently-empty index.

set -uo pipefail

CORTEXTOS_BIN="${CORTEXTOS_BIN:-cortextos}"
ORG="${CTX_ORG:-prop-firm-admin}"
AGENT="${CTX_AGENT_NAME:-devops}"

# Control query — must reliably match the shared corpus. If this stops matching
# because the corpus legitimately changed, update it; do not delete the check.
CONTROL_QUERY="${KB_CONTROL_QUERY:-market open flip strategy}"

# Spec asked for a 10s threshold. Measured healthy single-collection latency on
# this host is 12-18s: `import chromadb` alone is ~9s and PersistentClient init
# ~2.6s at load average 25-47 (18-agent fleet). 10s would fire on every run.
# Observed healthy runs land at 12-19s, so 20s would flap; 25s is the honest
# "healthy but slow host" line and still catches the 60s outage failure mode by
# a wide margin. Drop it toward 10s once host load is back to sane levels, or
# once chromadb is fronted by a resident server instead of a cold import.
THRESHOLD_MS="${KB_HEALTH_THRESHOLD_MS:-25000}"

BOT_TOKEN="8649138124:AAE2C5QfE2mSCgtHDo_ggveXKfmUvdA1hdo"
CHAT_ID="6585156851"

DRY_RUN="${DRY_RUN:-0}"

send_telegram() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[kb-health] DRY_RUN telegram:\n%s\n' "$1"
    return
  fi
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
}

CT_TIME=$(TZ=America/Chicago date '+%-I:%M %p CT')

# --- time a real query -----------------------------------------------------
START_NS=$(date +%s%N)
# --scope shared queries ONE collection. Default scope 'all' also queries
# agent-<name>, doubling wall time for no extra signal in a health probe.
OUTPUT=$("$CORTEXTOS_BIN" bus kb-query "$CONTROL_QUERY" \
  --org "$ORG" --agent "$AGENT" --scope shared 2>&1)
EXIT_CODE=$?
END_NS=$(date +%s%N)

ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

# Result count: the human-readable header is "Knowledge Base Results (n/total)".
RESULT_COUNT=$(printf '%s' "$OUTPUT" | sed -n 's/.*Knowledge Base Results (\([0-9]*\)\/.*/\1/p' | head -1)
[[ -z "$RESULT_COUNT" ]] && RESULT_COUNT=0

# Last few lines of output for the alert body — full output can be thousands of
# lines of search hits, which is useless in a Telegram message.
ERR_TAIL=$(printf '%s' "$OUTPUT" | tail -3 | tr '\n' ' ' | cut -c1-300)

meta_json() {
  printf '{"latency_ms":%s,"threshold_ms":%s,"exit_code":%s,"results":%s,"query":"%s"}' \
    "$ELAPSED_MS" "$THRESHOLD_MS" "$EXIT_CODE" "$RESULT_COUNT" "$CONTROL_QUERY"
}

FAIL_REASON=""
if [[ $EXIT_CODE -ne 0 ]]; then
  FAIL_REASON="kb-query exited ${EXIT_CODE}"
elif [[ "$RESULT_COUNT" -eq 0 ]]; then
  FAIL_REASON="control query returned 0 results (index may be empty or unreadable)"
elif [[ $ELAPSED_MS -gt $THRESHOLD_MS ]]; then
  FAIL_REASON="latency ${ELAPSED_MS}ms over ${THRESHOLD_MS}ms threshold"
fi

if [[ -n "$FAIL_REASON" ]]; then
  echo "[kb-health] FAIL: ${FAIL_REASON} (${ELAPSED_MS}ms, ${RESULT_COUNT} results)"
  "$CORTEXTOS_BIN" bus log-event error kb_health_degraded error \
    --meta "$(meta_json)" 2>/dev/null || true
  send_telegram "🔴 KB health check FAILED — ${CT_TIME}

Reason: ${FAIL_REASON}
Latency: ${ELAPSED_MS}ms (threshold ${THRESHOLD_MS}ms)
Results: ${RESULT_COUNT}
Query: \"${CONTROL_QUERY}\"

Output: ${ERR_TAIL}"
  exit 1
fi

echo "[kb-health] OK: ${ELAPSED_MS}ms, ${RESULT_COUNT} results"
"$CORTEXTOS_BIN" bus log-event action kb_health_ok info \
  --meta "$(meta_json)" 2>/dev/null || true
exit 0
