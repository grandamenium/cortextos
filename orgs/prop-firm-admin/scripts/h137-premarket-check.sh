#!/usr/bin/env bash
# h137-premarket-check.sh — All-strategy pre-market health check
# Fires at 13:15 UTC (08:15 CT) — 75-min window before H137 signal opens (09:30 ET).
# Checks ALL strategy_states rows with state='Active' seen within 7 days.
# Telegram to Chris gated on: pilot-account P0 (always) OR CT hour >= 08:00.
# DRYRUN=1: print findings, skip all sends (safe for testing).
DRYRUN="${DRYRUN:-0}"
cortextos bus update-cron-fire h137-premarket-check --interval 24h 2>/dev/null || true

DOW=$(date +%u)
if [[ $DOW -ge 6 ]]; then echo "[premarket-check] MARKET CLOSED (weekend) — $(date +'%A')"; exit 0; fi
set -u

DB="postgresql://orbfutures:orbfutures@127.0.0.1/orbfutures_dashboard"
CT_TIME=$(TZ=America/Chicago date '+%I:%M %p CT')
CT_HOUR=$(( 10#$(TZ=America/Chicago date '+%H') ))
BOT_TOKEN="8649138124:AAE2C5QfE2mSCgtHDo_ggveXKfmUvdA1hdo"
CHAT_ID="6585156851"
PILOT_ACCOUNT="PAAPEX4333770000017"
PILOT_STRATEGY="H137_BilateralBreakout"

# Known false-positives: account_name|strategy_name pairs excluded from RED alerts.
# Each entry MUST carry a reason and a removal condition.
SUPPRESSED_PAIRS=(
  'PPNTF100024895000002|MarketOpenFlip'  # tombstone-gap: detached strategy, pending Chris decision — remove when task_1784882768044 ships
  'APEX4333770000091|MarketOpenFlip'     # tombstone-gap: strategy removed from live state 2026-07-30, matches PPNTETL roster adjustment pattern — remove after Chris confirms in morning brief
)

is_suppressed() {
  local pair="$1" s
  for s in "${SUPPRESSED_PAIRS[@]}"; do
    [ "$s" = "$pair" ] && return 0
  done
  return 1
}

send_telegram() {
  local msg="$1"
  if [[ "$DRYRUN" == "1" ]]; then
    echo "[premarket-check] DRYRUN — would send Telegram: ${msg:0:80}..."
    return
  fi
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${msg}" > /dev/null 2>&1 || true
}

psql_q() { psql "$DB" -X -A -t -q -c "$1" 2>/dev/null; }

if ! psql "$DB" -X -A -t -q -c "SELECT 1" >/dev/null 2>&1; then
  echo "[premarket-check] ERROR: cannot connect to DB"
  exit 0
fi

# Fetch live NT8 account list from the relay API — used to suppress tombstone-gap false-positives.
# FAIL-OPEN: if the endpoint is unreachable or returns non-JSON, LIVE_ACCOUNTS stays empty
# and is_live_account returns 1 (unknown = treat as live = not suppressed).
NT8_STATE_URL="https://dashboard.profithits.app/api/nt8/state?node_id=HolyGrail"
LIVE_ACCOUNTS_JSON=$(curl -sf --max-time 10 "$NT8_STATE_URL" 2>/dev/null || echo "")
LIVE_ACCOUNTS=""
NT8_STATE_REACHABLE=0
if [ -n "$LIVE_ACCOUNTS_JSON" ]; then
  # F2: require connection=="online" to guard against cached stale data being served
  # when the terminal is actually offline (offline terminal + cached list would ghost-suppress real alerts).
  NT8_CONNECTION=$(printf '%s' "$LIVE_ACCOUNTS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('connection',''))" 2>/dev/null || echo "")
  LIVE_ACCOUNTS=$(printf '%s' "$LIVE_ACCOUNTS_JSON" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    accts=set(s.get('account','') for s in d.get('strategies',[]) if s.get('account'))
    print('\n'.join(sorted(accts)))
except: pass
" 2>/dev/null || true)
  [ -n "$LIVE_ACCOUNTS" ] && [ "$NT8_CONNECTION" = "online" ] && NT8_STATE_REACHABLE=1
fi

# Returns 0 (true) if account is confirmed present in live NT8 state.
# Returns 1 (unknown/absent) if NT8 state was unreachable OR account not found.
# Fail-open: unknown = treat as live = NOT suppressed as tombstone.
is_live_account() {
  local acct="$1"
  [ "$NT8_STATE_REACHABLE" -eq 0 ] && return 1  # fail-open: unknown → not suppressed
  printf '%s\n' "$LIVE_ACCOUNTS" | grep -qxF "$acct"
}

# Check pilot account first — P0 if stale/absent
PILOT_AGE=$(psql_q "
  SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - last_seen)) / 60)::int
  FROM strategy_states
  WHERE account_name='${PILOT_ACCOUNT}' AND strategy_name='${PILOT_STRATEGY}'
  ORDER BY last_seen DESC LIMIT 1;")
PILOT_P0=0
if [ -z "$PILOT_AGE" ] || [ "${PILOT_AGE:-0}" -gt 120 ]; then
  PILOT_P0=1
fi

# ACTIVE ROSTER: strategies seen within 48h = expected to run today.
# Rows stale >2h within that window are real alerts (recently broken).
# Zombie rows (>134h stale) are logged separately — never in the alert.
STALE_ROWS=$(psql_q "
  SELECT account_name, strategy_name,
         ROUND(EXTRACT(EPOCH FROM (NOW() - last_seen)) / 3600.0, 1)::text AS age_h
  FROM strategy_states
  WHERE state = 'Active'
    AND last_seen > NOW() - INTERVAL '48 hours'
    AND last_seen < NOW() - INTERVAL '2 hours'
  ORDER BY last_seen DESC;
")

# Zombie rows: Active but unseen for >134h — weekly cleanup candidates, not alerts.
ZOMBIE_COUNT=$(psql_q "
  SELECT COUNT(*) FROM strategy_states
  WHERE state = 'Active'
    AND last_seen < NOW() - INTERVAL '134 hours';
")

# Count fresh active strategies for OK log
ACTIVE_FRESH=$(psql_q "
  SELECT COUNT(*) FROM strategy_states
  WHERE state = 'Active'
    AND last_seen >= NOW() - INTERVAL '2 hours';
")

ZOMBIE_NOTE=""
if [ "${ZOMBIE_COUNT:-0}" -gt 0 ]; then
  ZOMBIE_NOTE=" (${ZOMBIE_COUNT} zombie rows >134h excluded — weekly cleanup)"
fi

# OK path — used both when nothing is stale and when every stale row is suppressed.
emit_ok() {
  local suppressed="${1:-0}" note=""
  if [ "$suppressed" -gt 0 ]; then
    note=" (suppressed ${suppressed} known false-positive"
    [ "$suppressed" -gt 1 ] && note="${note}s"
    note="${note})"
  fi
  echo "[premarket-check] OK: ${ACTIVE_FRESH} active strategies fresh${note}${ZOMBIE_NOTE} (${CT_TIME})"
  cortextos bus log-event action premarket_check_ok info \
    --meta "{\"fresh_count\":${ACTIVE_FRESH:-0},\"zombie_count\":${ZOMBIE_COUNT:-0},\"suppressed_count\":${suppressed}}" 2>/dev/null || true
}

if [ -z "$STALE_ROWS" ]; then
  if [ "$PILOT_P0" -eq 0 ]; then
    emit_ok 0
    exit 0
  fi
  # PILOT_P0=1 with no other stale rows: the STALE_LIST/STALE_COUNT reset below would
  # clobber any injection here — rely on the post-loop guard to inject the synthetic P0 entry.
fi

# Build stale list (active-roster only), skipping known false-positive pairs
# and accounts absent from live NT8 state (tombstone-gap suppression, fail-open).
STALE_LIST=""
STALE_COUNT=0
SUPPRESSED_COUNT=0
NT8_GHOST_COUNT=0
while IFS='|' read -r acct strat age_h; do
  [ -z "$acct" ] && continue
  if is_suppressed "${acct}|${strat}"; then
    echo "[premarket-check] SUPPRESSED: ${strat} / ${acct}: ${age_h}h stale (known false-positive)"
    SUPPRESSED_COUNT=$((SUPPRESSED_COUNT + 1))
    continue
  fi
  # NT8 reconciliation: DISABLED until multi-node + trades-evidence redesign ships.
  # Vincere terminal pushes to node_id="nt1" (INSTANCE_TAG unset) instead of "Vincere";
  # HolyGrail-only reconciliation was suppressing Vincere accounts at premarket,
  # silencing real alerts for live-trading accounts. F1+F2 pilot protection kept.
  # TODO: re-enable once Vincere INSTANCE_TAG is fixed and trades-override is implemented.
  # if [ "$acct" != "$PILOT_ACCOUNT" ] && [ "$NT8_STATE_REACHABLE" -eq 1 ] && ! is_live_account "$acct"; then
  #   ...
  # fi
  STALE_LIST="${STALE_LIST}  ${strat} / ${acct}: ${age_h}h stale"$'\n'
  STALE_COUNT=$((STALE_COUNT + 1))
done <<< "$STALE_ROWS"

# All stale rows were known false-positives — not a RED (unless pilot is P0).
if [ "$STALE_COUNT" -eq 0 ]; then
  if [ "$PILOT_P0" -eq 1 ]; then
    # F1 (post-loop path): every other stale row was suppressed but pilot is P0.
    # Inject pilot into the stale list so the RED alert path fires.
    STALE_LIST="  ${PILOT_STRATEGY} / ${PILOT_ACCOUNT}: ${PILOT_AGE:-absent}${PILOT_AGE:+min} stale — pilot P0"$'\n'
    STALE_COUNT=1
  else
    emit_ok "$SUPPRESSED_COUNT"
    exit 0
  fi
fi

MSG="PRE-MARKET RED (${CT_TIME}): ${STALE_COUNT} ACTIVE strategies stale >2h (NT8 offline or DLL failure):
${STALE_LIST}Verify NT8 terminals (HolyGrail/Vincere) before H137 window opens 9:30 ET.${ZOMBIE_NOTE}"

echo "[premarket-check] RED: ${STALE_COUNT} stale strategies${ZOMBIE_NOTE}"
echo "$STALE_LIST"

if [[ "$DRYRUN" != "1" ]]; then
  cortextos bus send-message fable-reviewer urgent "$MSG" 2>/dev/null || true
  cortextos bus send-message chief urgent "$MSG" 2>/dev/null || true
fi

# Telegram to Chris — three-case gate:
# 1. PILOT_P0=1 → always send (live-capital exception, any hour)
# 2. PILOT_P0=0 AND CT_HOUR < 9 → NO Chris ping (quiet hours end 09:00 CT); route stale list to agents only
# 3. PILOT_P0=0 AND CT_HOUR >= 9 → send to Chris
if [[ "$PILOT_P0" == "1" ]]; then
  send_telegram "$MSG"
elif [[ "$CT_HOUR" -ge 9 ]]; then
  send_telegram "$MSG"
else
  echo "[premarket-check] Quiet hours (${CT_TIME}, pilot not P0) — Chris Telegram suppressed. Stale list routed to agents only."
fi

# Severity: pilot P0 = critical (live capital at risk); non-pilot stale = warning (informational)
if [[ "$PILOT_P0" == "1" ]]; then
  SEV="critical"
else
  SEV="warning"
fi
NT8_STATE_NOTE=""
[ "$NT8_STATE_REACHABLE" -eq 0 ] && NT8_STATE_NOTE=" (NT8 state API unreachable — tombstone suppression disabled)"
cortextos bus log-event error premarket_stale_strategies "$SEV" \
  --meta "{\"stale_count\":${STALE_COUNT},\"fresh_count\":${ACTIVE_FRESH:-0},\"zombie_count\":${ZOMBIE_COUNT:-0},\"suppressed_count\":${SUPPRESSED_COUNT},\"nt8_ghost_count\":${NT8_GHOST_COUNT:-0},\"nt8_state_reachable\":${NT8_STATE_REACHABLE},\"pilot_p0\":${PILOT_P0}}" 2>/dev/null || true
[ -n "$NT8_STATE_NOTE" ] && echo "[premarket-check]${NT8_STATE_NOTE}"
