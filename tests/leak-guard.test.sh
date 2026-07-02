#!/usr/bin/env bash
#
# Falsifiability test for the leak-guard scanner (.github/scripts/leak-guard.sh).
#
# A scanner nobody has watched FAIL on a real leak is unproven. This asserts:
#   (a) it FAILS on a planted leak carrying the exact shape that leaked on
#       2026-07-01 — agent roster + a cron-timing table + an operator abs-path;
#   (b) it PASSES on the current clean tree (no false positives on the
#       legitimate framework convention: agent-name placeholders, lifeos
#       test fixtures, obvious placeholder tokens).
#
# The planted leak is generated in a temp dir at runtime — never committed —
# because a committed file carrying the operator path would itself trip the
# tree scan. The operator username is split ("cortex""tos") so THIS test file
# carries no operator-path literal.

set -uo pipefail
cd "$(dirname "$0")/.."
GUARD=".github/scripts/leak-guard.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
U="cortex""tos"
fails=0

cat > "$TMP/planted.md" <<EOF
# Phase Multi-Agent Report
| Agents simulated | 5 (boris, paul, sentinel, donna, nick) |
| paul | 6 | heartbeat(4h), morning-review(0 13 * * *), evening-review(0 1 * * *) |
Checked at /Users/$U/cortextos/orgs/lifeos/agents/boris/AGENTS.md
EOF

# (a) MUST FAIL on the planted leak, and report BOTH detections.
out=$(bash "$GUARD" "$TMP/planted.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a planted leak (should have failed)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in planted leak"; fails=1; }
printf '%s\n' "$out" | grep -q 'roster' \
  || { echo "FAIL: roster+cron table not detected in planted leak"; fails=1; }

# (c) Windowed heuristic: a MULTI-LINE ops table splits the agent name and its
#     cron expression across adjacent rows, evading the same-line RE. The
#     windowed check (WINDOW=3) must still FLAG it. Non-test path required.
cat > "$TMP/multiline.md" <<'EOF'
# Fleet Ops Table
| Agent    | paul                       |
| Cadence  | morning-review(0 13 * * *) |
EOF
bash "$GUARD" "$TMP/multiline.md" >/dev/null 2>&1 \
  && { echo "FAIL: scanner PASSED a multi-line roster+cron table (should have failed)"; fails=1; }
printf '%s\n' "$(bash "$GUARD" "$TMP/multiline.md" 2>&1)" | grep -q 'within 3 lines' \
  || { echo "FAIL: multi-line roster+cron not caught by windowed check"; fails=1; }

# (d) Control: a roster name and a cron expr FAR apart (well beyond the window)
#     must stay CLEAN — the window must not over-match across a whole document.
{ printf '| paul | agent |\n'; for i in $(seq 1 12); do printf 'filler line %s\n' "$i"; done; printf 'morning-review runs daily\n'; } > "$TMP/farapart.md"
bash "$GUARD" "$TMP/farapart.md" >/dev/null 2>&1 \
  || { echo "FAIL: windowed check flagged name+cron far apart (false positive)"; fails=1; }

# (b) MUST PASS on the current clean tree.
bash "$GUARD" --tree HEAD >/dev/null 2>&1 \
  || { echo "FAIL: scanner flagged the CLEAN tree (false positive)"; fails=1; }

if [ "$fails" -eq 0 ]; then echo "leak-guard.test: PASS"; else echo "leak-guard.test: FAIL"; exit 1; fi
