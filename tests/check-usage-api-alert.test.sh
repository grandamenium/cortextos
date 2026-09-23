#!/usr/bin/env bash
# Unit harness for check-usage-api.sh — DEFECT 1 (alert gating + generic routing)
# and DEFECT 2 (Codex usage-window labels derived by seconds, never positionally).
# Extracts the REAL _alert / _codex_windows / _codex_json functions from the
# script (no drift), mocks node + send-telegram + _codex_wham_usage, and asserts
# routing + by-value window correctness. Several assertions are DISCRIMINATING:
# they go RED against the pre-fix positional code (see tests 7, 9, 10).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$TEST_DIR/../bus/check-usage-api.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
nope() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
check(){ if eval "$2"; then ok "$1"; else nope "$1 :: [$2]"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── Mocks + globals the extracted functions reference ────────────────────────
NODE_LOG="$TMP/node.log"; : > "$NODE_LOG"
TG_LOG="$TMP/tg.log";     : > "$TG_LOG"

# Mock node -> capture the bus invocation instead of sending.
node() { echo "$*" >> "$NODE_LOG"; }

# Mock SCRIPT_DIR so _alert resolves a FAKE send-telegram.sh that just logs.
SCRIPT_DIR="$TMP/bin"; mkdir -p "$SCRIPT_DIR"
cat > "$SCRIPT_DIR/send-telegram.sh" <<'TG'
#!/usr/bin/env bash
echo "TG: $*" >> "$TG_LOG"
TG
chmod +x "$SCRIPT_DIR/send-telegram.sh"
export TG_LOG   # the fake send-telegram.sh runs in a child bash and needs this

ALERT_AGENT=""
SUPPRESS_TELEGRAM=false
CHAT_ID=""
ALERT_SENT=false

# Extract the real functions from the script and eval them here (no drift).
eval "$(sed -n '/^_alert() {/,/^}/p' "$SCRIPT")"
eval "$(sed -n '/^_codex_windows() {/,/^}/p' "$SCRIPT")"
eval "$(sed -n '/^_codex_json() {/,/^}/p' "$SCRIPT")"

# ═══════════════════════ DEFECT 1 — gating + routing ════════════════════════
echo "== DEFECT 1: generic gating + routing =="

# (1) agent from env (generic, NOT hardcoded) routed at the given priority
ALERT_AGENT="someorch"; SUPPRESS_TELEGRAM=false; CHAT_ID="12345"
: > "$NODE_LOG"; : > "$TG_LOG"
_alert "CODE RED body" high
check "1: env agent routed via bus at high" 'grep -q "bus send-message someorch high CODE RED body" "$NODE_LOG"'

# (2) --no-telegram suppresses Telegram but bus routing still fires
ALERT_AGENT="someorch"; SUPPRESS_TELEGRAM=true; CHAT_ID="12345"
: > "$NODE_LOG"; : > "$TG_LOG"
_alert "warn body" normal
check "2: suppress -> Telegram NOT called"   '[[ ! -s "$TG_LOG" ]]'
check "2: suppress -> bus still routes"        'grep -q "bus send-message someorch normal warn body" "$NODE_LOG"'

# (3) not suppressed + CHAT_ID set -> Telegram IS called
ALERT_AGENT=""; SUPPRESS_TELEGRAM=false; CHAT_ID="12345"
: > "$NODE_LOG"; : > "$TG_LOG"
_alert "warn body" normal
check "3: not suppressed -> Telegram called"   '[[ -s "$TG_LOG" ]]'

# (4) CODE-RED routed high; with suppress on it sends NO Telegram
ALERT_AGENT="someorch"; SUPPRESS_TELEGRAM=true; CHAT_ID="12345"
: > "$NODE_LOG"; : > "$TG_LOG"
_alert "CODE RED: Codex rate limit reached." high
check "4: CODE-RED routed high"                'grep -q "send-message someorch high" "$NODE_LOG"'
check "4: CODE-RED + suppress -> no Telegram"  '[[ ! -s "$TG_LOG" ]]'

# (5) PII gate: zero hardcoded agent names / owners in the source
check "5: PII gate (no paul/james)" '[[ "$(grep -icE "paul|james" "$SCRIPT")" -eq 0 ]]'

# ═══════════════════ DEFECT 2 — windows derived by seconds ══════════════════
echo "== DEFECT 2: _codex_windows derive-by-seconds =="

W_POS='{"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_after_seconds":100},"secondary_window":{"used_percent":70,"limit_window_seconds":604800,"reset_after_seconds":200}}}'
W_SWAP='{"rate_limit":{"primary_window":{"used_percent":70,"limit_window_seconds":604800},"secondary_window":{"used_percent":30,"limit_window_seconds":18000}}}'
W_INC='{"rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":604800},"secondary_window":null}}'
W_BAD='{"rate_limit":{"primary_window":{"used_percent":50,"limit_window_seconds":999}}}'

# (6) positive control: canonical order maps correctly
OUT6=$(printf '%s' "$W_POS" | _codex_windows)
check "6: pos control 5h=30" 'echo "$OUT6" | grep -q "CODEX_5H=30 "'
check "6: pos control 7d=70" 'echo "$OUT6" | grep -q "CODEX_7D=70 "'

# (7) DISCRIMINATING: swapped order still maps by seconds (RED vs positional code)
OUT7=$(printf '%s' "$W_SWAP" | _codex_windows)
check "7: swap still 5h=30 (discriminating)" 'echo "$OUT7" | grep -q "CODEX_5H=30 "'
check "7: swap still 7d=70 (discriminating)" 'echo "$OUT7" | grep -q "CODEX_7D=70 "'

# (8) incident shape: 7d=100, 5h absent
OUT8=$(printf '%s' "$W_INC" | _codex_windows)
check "8: incident 7d=100"     'echo "$OUT8" | grep -q "CODEX_7D=100 "'
check "8: incident 5h absent"  'echo "$OUT8" | grep -q "CODEX_5H=-1 "'

# (9) fail-loud on unrecognized window (must NOT be swallowed)
ERR9=$(printf '%s' "$W_BAD" | _codex_windows 2>&1); RC9=$?
check "9: unrecognized -> non-zero exit"     '[[ $RC9 -ne 0 ]]'
check "9: unrecognized -> error on stderr"   'echo "$ERR9" | grep -q "unrecognized limit_window_seconds"'

# (10) BY-VALUE output path: _codex_json labels swapped windows correctly
_codex_wham_usage() {
  printf '%s' '{"rate_limit":{"limit_reached":false,"allowed":true,"primary_window":{"used_percent":70,"limit_window_seconds":604800,"reset_after_seconds":200},"secondary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_after_seconds":100}}}'
}
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME/.codex"
echo '{"tokens":{"access_token":"x.y.z"}}' > "$FAKE_HOME/.codex/auth.json"
OUT10=$(HOME="$FAKE_HOME" _codex_json)
check "10: output utilization_5h==30 (by value)"        'echo "$OUT10" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get(\"utilization_5h\")==30, d"'
check "10: output utilization_7d==70 (by value)"        'echo "$OUT10" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get(\"utilization_7d\")==70, d"'
check "10: output limit_window_seconds_7d==604800"      'echo "$OUT10" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get(\"limit_window_seconds_7d\")==604800, d"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
