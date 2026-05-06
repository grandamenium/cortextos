#!/bin/bash
# Hook: pre-pr-review.sh
# Trigger: PreToolUse on Bash
# Purpose: Block `gh pr create` / `gh pr merge` / `git push origin main|master`
#          unless a fresh /local-ultrareview review exists for today.
#
# stdin JSON: { session_id, tool_name, tool_input: { command, ... }, ... }
# Block protocol: exit 2 with reason on stderr → Claude reads it and reacts.

set -eu

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null || echo "")
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || echo "")

# Match the high-stakes commands. Be conservative: only intercept these exact verbs.
case "$CMD" in
    *"gh pr create"*|*"gh pr merge"*|*"git push origin main"*|*"git push origin master"*)
        ;;
    *)
        exit 0
        ;;
esac

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$PROJECT_ROOT" || exit 0

TODAY=$(date +%Y-%m-%d)
# Any review dir whose name ends in today's date counts as a fresh review.
FRESH=$(find reviews -maxdepth 1 -type d -name "*-${TODAY}" 2>/dev/null | head -1)

if [ -n "$FRESH" ]; then
    echo "[pre-pr-review] Fresh review found: $FRESH — allowing." >&2
    exit 0
fi

# No fresh review — block.
cat >&2 <<'EOF'
[pre-pr-review] BLOCKED — no /local-ultrareview run today.

Quality Gate 1 requires a fresh review before any PR / merge / push to main.

Run this first:
    /local-ultrareview

That writes reviews/<branch>-<date>/ which unblocks this command. If the
review surfaces critical findings, address them before re-attempting.

(Override: only do this with explicit user waiver — set DISABLE_GATE_1=1 in env.)
EOF

# Honour per-invocation override if user explicitly set it.
if [ "${DISABLE_GATE_1:-0}" = "1" ]; then
    echo "[pre-pr-review] DISABLE_GATE_1=1 — bypassing." >&2
    exit 0
fi

exit 2
