#!/usr/bin/env bash
# verify-stamp.sh <file-path> [scope]
# Exit 0 = PASS stamp found for this file's sha256.
# Exit 1 = not stamped (fail-closed: missing stamps.jsonl also exits 1).
#
# Usage:
#   guards/verify-stamp.sh /path/to/video.mp4
#   guards/verify-stamp.sh /path/to/video.mp4 laws-short
#
# Every call is logged to verifications.log and bus log-event on REJECT.

set -euo pipefail

FILE="${1:-}"
SCOPE="${2:-}"

STAMPS_FILE="$(dirname "$0")/../agents/fable-reviewer/gate-stamps/stamps.jsonl"
VERIFY_LOG="$(dirname "$0")/../agents/fable-reviewer/gate-stamps/verifications.log"

# ── Input validation ─────────────────────────────────────────────────────────
if [[ -z "$FILE" ]]; then
  echo "[verify-stamp] ERROR: no file argument provided" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "[verify-stamp] ERROR: file not found: $FILE" >&2
  exit 1
fi

# ── Fail-closed: stamps.jsonl must exist ────────────────────────────────────
if [[ ! -f "$STAMPS_FILE" ]]; then
  echo "[verify-stamp] REJECT: stamps.jsonl missing — fail-closed. File: $FILE" >&2
  cortextos bus log-event action gate_verify_reject error \
    --meta "{\"file\":\"$FILE\",\"reason\":\"stamps_missing\"}" 2>/dev/null || true
  exit 1
fi

# ── Compute sha256 ──────────────────────────────────────────────────────────
HASH=$(sha256sum "$FILE" | awk '{print $1}')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BASENAME=$(basename "$FILE")

# ── Grep stamps for a PASS entry with this hash ─────────────────────────────
# Accept any scope if caller didn't specify one; otherwise require scope match.
if [[ -n "$SCOPE" ]]; then
  MATCH=$(python3 -c "
import json, sys
found = False
with open('$STAMPS_FILE') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            e = json.loads(line)
            if e.get('sha256') == '$HASH' and e.get('verdict') == 'PASS' and e.get('scope','') == '$SCOPE':
                found = True; break
        except: pass
print('1' if found else '0')
" 2>/dev/null || echo "0")
else
  MATCH=$(python3 -c "
import json, sys
found = False
with open('$STAMPS_FILE') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            e = json.loads(line)
            if e.get('sha256') == '$HASH' and e.get('verdict') == 'PASS':
                found = True; break
        except: pass
print('1' if found else '0')
" 2>/dev/null || echo "0")
fi

# ── Log verification attempt ─────────────────────────────────────────────────
LOG_ENTRY="{\"ts\":\"$TIMESTAMP\",\"file\":\"$BASENAME\",\"hash\":\"$HASH\",\"scope\":\"$SCOPE\",\"result\":\"$([ "$MATCH" = "1" ] && echo PASS || echo REJECT)\"}"
echo "$LOG_ENTRY" >> "$VERIFY_LOG" 2>/dev/null || true

# ── Result ───────────────────────────────────────────────────────────────────
if [[ "$MATCH" = "1" ]]; then
  echo "[verify-stamp] PASS: $BASENAME (sha256: ${HASH:0:12}...)"
  exit 0
else
  echo "[verify-stamp] REJECT: no PASS stamp found for $BASENAME (sha256: ${HASH:0:12}...)" >&2
  echo "[verify-stamp] Upload blocked. File must be reviewed and stamped by fable-reviewer before upload." >&2
  cortextos bus log-event action gate_verify_reject error \
    --meta "{\"file\":\"$BASENAME\",\"hash\":\"${HASH:0:16}\",\"scope\":\"$SCOPE\"}" 2>/dev/null || true
  exit 1
fi
