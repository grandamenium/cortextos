#!/usr/bin/env bash
# h137-monitor.sh — H137 EOD monitoring script
# Fires at 21:30 UTC (4:30 PM CT) post-close, Mon-Fri.
# Checks: strategy attachment, today's trade count, tripwire logic.
# Output: OK / TRIPWIRE YELLOW / TRIPWIRE RED
DRYRUN="${DRYRUN:-0}"

DB="postgresql://orbfutures:orbfutures@127.0.0.1/orbfutures_dashboard"
PILOT_ACCOUNT="PAAPEX4333770000017"
PILOT_STRATEGY="H137_BilateralBreakout"
CT_TIME=$(TZ=America/Chicago date '+%I:%M %p CT')

psql_q() { psql "$DB" -X -A -t -q -c "$1" 2>/dev/null; }

if ! psql "$DB" -X -A -t -q -c "SELECT 1" >/dev/null 2>&1; then
  echo "TRIPWIRE RED: cannot connect to DB"
  exit 1
fi

# Strategy attachment check
STRAT_AGE=$(psql_q "
  SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - last_seen)) / 60)::int
  FROM strategy_states
  WHERE account_name='${PILOT_ACCOUNT}' AND strategy_name='${PILOT_STRATEGY}'
  ORDER BY last_seen DESC LIMIT 1;")

# Trade count today (excluding Chris-excluded off-config trades)
TRADE_COUNT=$(psql_q "
  SELECT COUNT(*) FROM trades t
  WHERE t.account_name='${PILOT_ACCOUNT}'
    AND t.entry_time >= NOW()::date
    AND t.entry_time < NOW()::date + INTERVAL '1 day'
    AND NOT EXISTS (SELECT 1 FROM h137_trade_exclusions e WHERE e.trade_id = t.id);")

TRADE_COUNT="${TRADE_COUNT:-0}"

# Model-match series count (lifetime, exclusions respected)
SERIES_COUNT=$(psql_q "
  SELECT COUNT(*) FROM trades t
  WHERE t.account_name='${PILOT_ACCOUNT}'
    AND t.strategy_name='${PILOT_STRATEGY}'
    AND NOT EXISTS (SELECT 1 FROM h137_trade_exclusions e WHERE e.trade_id = t.id);")

SERIES_COUNT="${SERIES_COUNT:-0}"

# Open positions — use trades table (exit_time IS NULL) not positions table.
# Positions table can carry stale qty rows after exit; trades exit_time is authoritative.
OPEN_QTY=$(psql_q "
  SELECT COUNT(*) FROM trades
  WHERE account_name='${PILOT_ACCOUNT}'
    AND strategy_name='${PILOT_STRATEGY}'
    AND entry_time >= NOW()::date
    AND exit_time IS NULL;")

OPEN_QTY="${OPEN_QTY:-0}"

# PnL today (closed trades)
PNL_TODAY=$(psql_q "
  SELECT COALESCE(SUM(pnl_dollars), 0)::numeric(10,2)
  FROM trades
  WHERE account_name='${PILOT_ACCOUNT}'
    AND entry_time >= NOW()::date
    AND exit_time IS NOT NULL;")

PNL_TODAY="${PNL_TODAY:-0}"

# --- Tripwire logic ---

# RED: strategy detached (stale >2h or absent)
if [ -z "$STRAT_AGE" ] || [ "${STRAT_AGE:-0}" -gt 120 ]; then
  echo "TRIPWIRE RED (${CT_TIME}): H137_BilateralBreakout on ${PILOT_ACCOUNT} DETACHED (age=${STRAT_AGE:-absent} min). NT8 may be offline."
  exit 0
fi

# YELLOW: open position at EOD (should be flat)
if [ "${OPEN_QTY}" -gt 0 ]; then
  echo "TRIPWIRE YELLOW (${CT_TIME}): Open position at EOD — ${OPEN_QTY} contracts still open on ${PILOT_ACCOUNT}. Verify flat before tomorrow."
  exit 0
fi

# OK
if [ "${TRADE_COUNT}" -gt 0 ]; then
  echo "OK (${CT_TIME}): H137 Day closed. ${TRADE_COUNT} trade(s). PnL today: \$${PNL_TODAY}. Series: ${SERIES_COUNT}/30. Strategy fresh (${STRAT_AGE}min). Flat at EOD."
else
  echo "OK (${CT_TIME}): H137 Day closed — 0 trades fired today. Series: ${SERIES_COUNT}/30. Strategy fresh (${STRAT_AGE}min). Flat."
fi
