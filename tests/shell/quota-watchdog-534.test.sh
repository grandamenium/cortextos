#!/bin/bash
# Regression test for issue #534. Runs the REAL scripts under a stubbed cortextos.
# Usage: test-534.sh <quota-watchdog.sh> <quota-resume.sh>
set -uo pipefail
WD="$1"; RS="$2"
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

make_stub(){ # $1=dir
  cat > "$1/cortextos" <<'EOF'
#!/bin/bash
case "$1 $2" in
  "bus check-usage-api") echo "{\"five_hour_utilization\":${STUB_5H:-0.95},\"seven_day_utilization\":0.5}"; exit 0 ;;
  "bus list-agents") [ "${STUB_LIST_FAIL:-0}" = "1" ] && exit 1; echo "${STUB_LIST_JSON:-[]}"; exit 0 ;;
  "bus send-telegram") exit 0 ;;
  "bus log-event") exit 0 ;;
esac
case "$1" in
  start) [ "$2" = "${STUB_START_FAIL:-}" ] && exit 1; exit 0 ;;
  stop)  [ "$2" = "${STUB_STOP_FAIL:-}" ]  && exit 1; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$1/cortextos"
}

newcase(){ # echoes a fresh CTXROOT, sets globals R/STUB/CTXROOT/PAUSED/WDLOG
  R=$(mktemp -d /tmp/wd534c.XXXXXX); STUB="$R/stub"; mkdir -p "$STUB"; CTXROOT="$R/ctx"; mkdir -p "$CTXROOT"
  make_stub "$STUB"
  PAUSED="$CTXROOT/state/quota-watchdog/paused.json"
  WDLOG="$CTXROOT/state/quota-watchdog/watchdog.log"
}
base_env(){ echo CORTEXTOS="$STUB/cortextos" JQ=/usr/bin/jq CCUSAGE=/nonexistent CLAUDE_CODE_OAUTH_TOKEN=dummy CTX_ROOT="$CTXROOT" CTX_FRAMEWORK_ROOT="$R" CTX_ORG=test QUOTA_THRESHOLD_PCT=10 QUOTA_RESUME_PCT=50; }

echo "== Bug A: snapshot failure must NOT write a stale empty paused.json =="
newcase
env $(base_env) STUB_5H=0.95 STUB_LIST_FAIL=1 bash "$WD" >/dev/null 2>&1
if [ -f "$PAUSED" ]; then
  pc=$(/usr/bin/jq -r '(.agents_paused // .agents // [])|length' "$PAUSED" 2>/dev/null)
  bad "Bug A — paused.json written on snapshot failure (agents=$pc)"
else
  grep -qi "snapshot failed" "$WDLOG" 2>/dev/null && ok "snapshot failure bailed, no paused.json, logged" || ok "no paused.json on snapshot failure"
fi
rm -rf "$R"

echo "== Bug A: zero running agents must NOT write paused.json =="
newcase
env $(base_env) STUB_5H=0.95 STUB_LIST_JSON='[]' bash "$WD" >/dev/null 2>&1
[ -f "$PAUSED" ] && bad "wrote paused.json with zero running agents" || ok "zero running agents → no paused-state"
rm -rf "$R"

echo "== control: healthy quota must NOT trip =="
newcase
env $(base_env) STUB_5H=0.10 STUB_LIST_JSON='[{"name":"a","running":true}]' bash "$WD" >/dev/null 2>&1
[ -f "$PAUSED" ] && bad "tripped on healthy quota" || ok "no trip on healthy quota (remaining 90%)"
rm -rf "$R"

echo "== positive: real trip with running agents pauses & records them =="
newcase
env $(base_env) STUB_5H=0.95 STUB_LIST_JSON='[{"name":"alpha","running":true},{"name":"beta","running":true}]' bash "$WD" >/dev/null 2>&1
if [ -f "$PAUSED" ]; then
  pc=$(/usr/bin/jq -r '(.agents_paused//[])|length' "$PAUSED")
  [ "$pc" = "2" ] && ok "tripped, recorded 2 paused agents" || bad "recorded $pc agents (want 2)"
else bad "no paused.json on a legit trip"; fi
rm -rf "$R"

echo "== Bug B: resume must capture & report start failures =="
newcase
mkdir -p "$(dirname "$PAUSED")"
printf '{"paused_at":"x","agents_paused":["ghost","real"]}' > "$PAUSED"
env CORTEXTOS="$STUB/cortextos" JQ=/usr/bin/jq CTX_ROOT="$CTXROOT" CTX_FRAMEWORK_ROOT="$R" CTX_ORG=test STUB_START_FAIL=ghost bash "$RS" >/dev/null 2>&1
if grep -qi "resume partial\|start failed: ghost" "$WDLOG" 2>/dev/null; then
  ok "resume surfaced the failed agent (parent-shell state preserved)"
else
  bad "Bug B — start failure not surfaced after loop"
fi
rm -rf "$R"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
