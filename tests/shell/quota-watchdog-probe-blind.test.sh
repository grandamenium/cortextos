#!/bin/bash
# Regression test for SYS-PROBE-BLIND-01: probe-blind-on-auth-failure guard.
# Verifies that a missing OAuth token never triggers a fleet pause, while a
# genuine low-quota reading with a valid token still fires correctly.
#
# SA score-check criteria (EXP-QUOTA-WATCHDOG-01):
#   (1) auth-failure / token-missing → PROBE_BLIND path, no pause
#   (2) genuine REAL_LOW_QUOTA with valid token → pause fires (coverage not lost)
#   (3) 0% read with no valid auth → no pause (the 2026-06-18 false-pause class)
#   (4) probe-blind alerts exactly once per episode (dedup flag)
#
# Usage: bash quota-watchdog-probe-blind.test.sh <quota-watchdog.sh>
set -uo pipefail
WD="$1"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

make_stub() {  # $1=stub-dir
  local sdir="$1"
  # Single-quoted heredoc so all ${VAR} references are evaluated at stub runtime
  cat > "$sdir/cortextos" <<'STUB_EOF'
#!/bin/bash
case "$1 $2" in
  "bus check-usage-api") echo "{\"five_hour_utilization\":${STUB_5H:-0.05},\"seven_day_utilization\":0.03}"; exit 0 ;;
  "bus list-agents")     [ "${STUB_LIST_FAIL:-0}" = "1" ] && exit 1; echo "${STUB_LIST_JSON:-[]}"; exit 0 ;;
  "bus send-telegram")   echo "telegram_called" >> "${CTX_ROOT}/telegram-calls.log"; exit 0 ;;
  "bus log-event")       exit 0 ;;
esac
case "$1" in
  start) exit 0 ;;
  stop)  exit 0 ;;
esac
exit 0
STUB_EOF
  chmod +x "$sdir/cortextos"

  # Stub security to always fail (no keychain entry) — prevents real keychain
  # reads from providing a token in blind-path test cases
  cat > "$sdir/security" <<'EOF'
#!/bin/bash
exit 1
EOF
  chmod +x "$sdir/security"

  # jq symlink so stub PATH resolves it
  ln -sf /usr/bin/jq "$sdir/jq"
  ln -sf /bin/bash "$sdir/bash"
}

newcase() {
  R=$(mktemp -d /tmp/wdpb.XXXXXX)
  STUB="$R/stub"; mkdir -p "$STUB"
  CTXROOT="$R/ctx"; mkdir -p "$CTXROOT"
  make_stub "$STUB" "$CTXROOT"
  PAUSED="$CTXROOT/state/quota-watchdog/paused.json"
  WDLOG="$CTXROOT/state/quota-watchdog/watchdog.log"
  BLIND_FLAG="$CTXROOT/state/quota-watchdog/.probe-blind-since"
  CHECKFILE="$CTXROOT/state/quota-watchdog/last-check.json"
  TELEGRAM_LOG="$CTXROOT/telegram-calls.log"
}

# Env for PROBE_BLIND scenario: no token from env, credentials, or keychain
# PATH includes stub dir first so 'security' resolves to the stub that exits 1
blind_env() {
  printf '%s' "CORTEXTOS=${STUB}/cortextos JQ=${STUB}/jq CCUSAGE=/nonexistent "
  printf '%s' "CLAUDE_CODE_OAUTH_TOKEN= CLAUDE_CREDS=/nonexistent/creds.json "
  printf '%s' "PATH=${STUB}:/usr/bin:/bin "
  printf '%s' "CTX_ROOT=${CTXROOT} CTX_FRAMEWORK_ROOT=${R} CTX_ORG=test "
  printf '%s' "QUOTA_THRESHOLD_PCT=10 QUOTA_RESUME_PCT=50"
}

# Env for normal scenario: valid token provided directly
authed_env() {
  printf '%s' "CORTEXTOS=${STUB}/cortextos JQ=${STUB}/jq CCUSAGE=/nonexistent "
  printf '%s' "CLAUDE_CODE_OAUTH_TOKEN=dummy_valid_token CLAUDE_CREDS=/nonexistent/creds.json "
  printf '%s' "PATH=${STUB}:/usr/bin:/bin "
  printf '%s' "CTX_ROOT=${CTXROOT} CTX_FRAMEWORK_ROOT=${R} CTX_ORG=test "
  printf '%s' "QUOTA_THRESHOLD_PCT=10 QUOTA_RESUME_PCT=50"
}

# ── Criterion 1: no token → PROBE_BLIND, no pause ───────────────────────────
echo "== [C1] no token + no accounts.json → PROBE_BLIND, no pause =="
newcase
env $(blind_env) STUB_5H=0.98 \
    STUB_LIST_JSON='[{"name":"alpha","running":true}]' \
    bash "$WD" >/dev/null 2>&1
if [ -f "$PAUSED" ]; then
  bad "C1: paused.json written despite no auth token (false-pause class)"
else
  ok "C1: no paused.json when token is absent"
fi
if [ -f "$CHECKFILE" ] && /usr/bin/jq -e '.probe_blind == true' "$CHECKFILE" >/dev/null 2>&1; then
  ok "C1: last-check.json records probe_blind=true"
else
  bad "C1: last-check.json missing or does not record probe_blind=true"
fi
rm -rf "$R"

# ── Criterion 3: 0% remaining with no valid auth → no pause ─────────────────
echo "== [C3] 0% remaining (STUB_5H=1.0) with no auth → no pause =="
newcase
env $(blind_env) STUB_5H=1.0 \
    STUB_LIST_JSON='[{"name":"alpha","running":true}]' \
    bash "$WD" >/dev/null 2>&1
if [ -f "$PAUSED" ]; then
  bad "C3: pause fired on 0%-remaining with no auth (the 2026-06-18 false-pause)"
else
  ok "C3: no pause on 0%-remaining when no auth token (probe-blind path)"
fi
rm -rf "$R"

# ── Criterion 2: valid token + genuine low quota → pause fires ───────────────
echo "== [C2] valid token + 0% remaining → pause fires (real-trip coverage) =="
newcase
env $(authed_env) STUB_5H=0.98 \
    STUB_LIST_JSON='[{"name":"alpha","running":true},{"name":"beta","running":true}]' \
    bash "$WD" >/dev/null 2>&1
if [ -f "$PAUSED" ]; then
  pc=$(/usr/bin/jq -r '(.agents_paused//[])|length' "$PAUSED" 2>/dev/null)
  [ "$pc" = "2" ] && ok "C2: genuine trip fired, 2 agents recorded" || bad "C2: trip fired but recorded $pc agents (want 2)"
else
  bad "C2: no pause on genuine low quota with valid token (coverage lost!)"
fi
rm -rf "$R"

# ── Criterion 2 (healthy quota): valid token + high remaining → no pause ─────
echo "== [C2-healthy] valid token + healthy quota → no pause =="
newcase
env $(authed_env) STUB_5H=0.05 \
    STUB_LIST_JSON='[{"name":"alpha","running":true}]' \
    bash "$WD" >/dev/null 2>&1
[ -f "$PAUSED" ] && bad "C2-healthy: tripped on healthy quota" || ok "C2-healthy: no trip on 95% remaining"
rm -rf "$R"

# ── Criterion 4: probe-blind alert fires once, not on repeated ticks ─────────
echo "== [C4] probe-blind alert fires once per episode =="
newcase
env $(blind_env) bash "$WD" >/dev/null 2>&1
env $(blind_env) bash "$WD" >/dev/null 2>&1
env $(blind_env) bash "$WD" >/dev/null 2>&1
if [ -f "$BLIND_FLAG" ]; then
  ok "C4: probe-blind dedup flag written after first run"
else
  bad "C4: probe-blind dedup flag missing after first run"
fi
TELEGRAM_CALLS=$(wc -l < "$TELEGRAM_LOG" 2>/dev/null | tr -d ' ')
if [ "${TELEGRAM_CALLS:-0}" -le 1 ]; then
  ok "C4: send-telegram called at most once across 3 runs (dedup working)"
else
  bad "C4: send-telegram called $TELEGRAM_CALLS times across 3 runs (dedup broken)"
fi
rm -rf "$R"

# ── Probe-blind flag clears when token is restored ───────────────────────────
echo "== [C4-clear] probe-blind flag clears on token restore =="
newcase
env $(blind_env) bash "$WD" >/dev/null 2>&1
if [ ! -f "$BLIND_FLAG" ]; then
  bad "C4-clear: blind flag not set by first (blind) run"
  rm -rf "$R"
else
  env $(authed_env) STUB_5H=0.05 bash "$WD" >/dev/null 2>&1
  if [ -f "$BLIND_FLAG" ]; then
    bad "C4-clear: probe-blind flag not cleared after token restoration"
  else
    ok "C4-clear: probe-blind flag cleared when auth is restored"
  fi
  rm -rf "$R"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
