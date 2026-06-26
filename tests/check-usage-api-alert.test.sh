#!/usr/bin/env bash
# Unit harness for check-usage-api.sh alert routing (Finding J).
# Extracts the REAL _in_quiet_band/_alert functions + codex-fields formatter from
# the script (no drift), mocks node/date, and asserts:
#   - per-condition fire-once + re-arm (dedup)
#   - quiet-band TOTAL suppression -> suppressed JSONL (exact shape) + catch-up DROP
#   - open-band routes through `bus send-message paul <priority>`, NEVER Telegram
#   - codex fields (plan/5h/24h/expiry) formatted onto the payload, humanized
#   - DISCRIMINATING: zero `send-telegram` references remain in the script
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../bus/check-usage-api.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
nope() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
check(){ if eval "$2"; then ok "$1"; else nope "$1 :: [$2]"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── Globals the extracted functions reference ────────────────────────────────
MARKER_DIR="$TMP/markers"; SUPPRESSED_LOG="$TMP/suppressed.jsonl"
mkdir -p "$MARKER_DIR"
QUIET_START=20; QUIET_END=5
CLI="$TMP/cli.js"          # dummy path; mocked node never reads it
NODE_LOG="$TMP/node.log"; : > "$NODE_LOG"
ALERT_SENT=false
MOCK_HOUR=12               # default: outside quiet band

# Mock node -> capture the bus invocation instead of sending.
node() { echo "NODE: $*" >> "$NODE_LOG"; }
# Mock date -> +%H returns MOCK_HOUR; everything else a fixed ISO ts.
date() { case "$*" in *"+%H"*) echo "$MOCK_HOUR" ;; *) echo "2026-06-10T${MOCK_HOUR}:00:00Z" ;; esac; }

# Extract the real functions from the script and eval them here.
eval "$(sed -n '/^_in_quiet_band() {/,/^}/p' "$SCRIPT")"
eval "$(sed -n '/^_alert() {/,/^}/p' "$SCRIPT")"

echo "== _in_quiet_band (wrap-midnight 20..05) =="
MOCK_HOUR=21; check "21:00Z is in-band"      '_in_quiet_band'
MOCK_HOUR=03; check "03:00Z is in-band"      '_in_quiet_band'
MOCK_HOUR=05; check "05:00Z is OUT (exclusive end)" '! _in_quiet_band'
MOCK_HOUR=12; check "12:00Z is out-of-band"  '! _in_quiet_band'
MOCK_HOUR=20; check "20:00Z is in-band (inclusive start)" '_in_quiet_band'

echo "== open-band: fire-once + re-arm + bus routing =="
MOCK_HOUR=12; : > "$NODE_LOG"; rm -f "$MARKER_DIR"/*
_alert "claude-7d" "reset-A" "CODE RED msg" high
check "open-band send routed to paul"   'grep -q "send-message paul high USAGE-ALERT claude-7d: CODE RED msg" "$NODE_LOG"'
check "marker written with state value"  '[[ "$(cat "$MARKER_DIR/claude-7d")" == "reset-A" ]]'
: > "$NODE_LOG"
_alert "claude-7d" "reset-A" "CODE RED msg" high
check "same value -> NO re-send (fire-once)" '[[ ! -s "$NODE_LOG" ]]'
: > "$NODE_LOG"
_alert "claude-7d" "reset-B" "CODE RED msg" high
check "changed value -> re-arms + sends"     'grep -q "USAGE-ALERT claude-7d" "$NODE_LOG"'

echo "== quiet-band: total suppression + JSONL shape + catch-up DROP =="
MOCK_HOUR=02; : > "$NODE_LOG"; : > "$SUPPRESSED_LOG"; rm -f "$MARKER_DIR"/*
_alert "claude-5h" "reset-C" "5h warning" normal
check "quiet-band: NO bus message"            '[[ ! -s "$NODE_LOG" ]]'
check "quiet-band: appended one JSONL line"   '[[ "$(wc -l < "$SUPPRESSED_LOG")" -eq 1 ]]'
check "JSONL is valid + exact contract shape" 'python3 -c "import json,sys; d=json.loads(open(\"$SUPPRESSED_LOG\").read()); assert set(d)=={\"ts\",\"condition\",\"value\",\"message\"}, d; assert d[\"condition\"]==\"claude-5h\" and d[\"value\"]==\"reset-C\" and d[\"message\"]==\"5h warning\""'
check "quiet-band advanced marker (DROP)"     '[[ "$(cat "$MARKER_DIR/claude-5h")" == "reset-C" ]]'
# Band ends, same value still holds -> must NOT re-send (catch-up = DROP).
MOCK_HOUR=12; : > "$NODE_LOG"
_alert "claude-5h" "reset-C" "5h warning" normal
check "post-band same value -> DROP (no catch-up send)" '[[ ! -s "$NODE_LOG" ]]'

echo "== discriminating: zero direct-Telegram references =="
check "grep send-telegram == 0" '[[ "$(grep -c "send-telegram" "$SCRIPT")" -eq 0 ]]'

echo "== codex fields formatter (real extracted python) =="
PYSTART=$(grep -n 'python3 -c .$' "$SCRIPT" | grep -A0 'CODEX_JSON' | head -1 | cut -d: -f1)
# Fallback: the codex-fields python -c opens with: CODEX_JSON="$CODEX_JSON" python3 -c '
PYSTART=$(grep -n 'CODEX_JSON="\$CODEX_JSON" python3 -c' "$SCRIPT" | head -1 | cut -d: -f1)
PYEND=$(awk -v s="$PYSTART" "NR>s && /^' 2>\\/dev\\/null/ {print NR; exit}" "$SCRIPT")
PYSRC=$(sed -n "$((PYSTART+1)),$((PYEND-1))p" "$SCRIPT")
SAMPLE='{"plan_type":"pro","token_expires_in_hours":10.0,"tokens_5h":4900000,"tokens_24h":30000}'
OUT=$(CODEX_JSON="$SAMPLE" python3 -c "$PYSRC")
check "fields: plan present"        'echo "$OUT" | grep -q "plan=pro"'
check "fields: 5h humanized (4.9M)" 'echo "$OUT" | grep -q "5h=4.9Mtok"'
check "fields: 24h humanized (30K)" 'echo "$OUT" | grep -q "24h=30.0Ktok"'
check "fields: expiry present"      'echo "$OUT" | grep -q "token expires=10.0h"'
OUT2=$(CODEX_JSON='{}' python3 -c "$PYSRC")
check "missing codex -> graceful '?'" 'echo "$OUT2" | grep -q "plan=unknown" && echo "$OUT2" | grep -q "token expires=?"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
