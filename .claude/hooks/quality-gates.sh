#!/bin/bash
# Hook: quality-gates.sh
# Trigger: Stop (when Claude finishes a response)
# Purpose:
#   Gate 2 — auto-fire skill-optimizer when 3+ skills used in this session
#            (blocks Stop with exit 2 → directive injected → Claude runs it)
#   Mulch  — best-effort `mulch sync` to commit any .mulch/ changes
#
# stdin JSON: { session_id, stop_hook_active, ... }

set -eu

INPUT=$(cat 2>/dev/null || echo '{}')

SESSION_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || echo "")
STOP_ACTIVE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("stop_hook_active",False))' 2>/dev/null || echo "False")

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$PROJECT_ROOT" || exit 0

STATE_DIR=".claude/.gates-state"
mkdir -p "$STATE_DIR"

# ---- Gate 2: skill-optimizer ----------------------------------------------
PROJECT_SLUG=$(printf '%s' "$PROJECT_ROOT" | sed 's|/|-|g; s| |-|g')
TRANSCRIPT_DIR="$HOME/.claude/projects/$PROJECT_SLUG"
LATEST_JSONL=""
SKILL_INVOCATIONS=0
TOP_SKILL=""
if [ -d "$TRANSCRIPT_DIR" ]; then
    for f in "$TRANSCRIPT_DIR"/*.jsonl; do
        [ -f "$f" ] || continue
        if [ -z "$LATEST_JSONL" ] || [ "$f" -nt "$LATEST_JSONL" ]; then
            LATEST_JSONL="$f"
        fi
    done
    if [ -n "$LATEST_JSONL" ]; then
        SKILL_INVOCATIONS=$(grep -oE '"name":"Skill"' "$LATEST_JSONL" 2>/dev/null | wc -l | tr -d ' ')
        SKILL_INVOCATIONS=${SKILL_INVOCATIONS:-0}
        # Extract the most-used skill name from "skill":"X" arguments
        TOP_SKILL=$(grep -oE '"skill":"[^"]+"' "$LATEST_JSONL" 2>/dev/null \
            | sort | uniq -c | sort -rn | head -1 \
            | grep -oE '"skill":"[^"]+"' | sed 's/"skill":"//; s/"$//' || echo "")
    fi
fi

# Per-session marker prevents infinite Stop-loop if Claude can't satisfy.
SESSION_MARKER="$STATE_DIR/skill-optimizer-${SESSION_ID:-nosession}"
TODAY=$(date +%Y-%m-%d)
HAS_TODAY_OUTPUT=$(find skill-improvement -maxdepth 2 -type f -name "${TODAY}-*" 2>/dev/null | head -1)

if [ "$SKILL_INVOCATIONS" -ge 3 ] \
   && [ ! -f "$SESSION_MARKER" ] \
   && [ -z "$HAS_TODAY_OUTPUT" ] \
   && [ "$STOP_ACTIVE" != "True" ]; then
    touch "$SESSION_MARKER"
    SKILL_TARGET="${TOP_SKILL:-<most-used-skill>}"
    cat >&2 <<EOF
[quality-gates] Gate 2 due — $SKILL_INVOCATIONS Skill invocation(s) this session.

Run skill-optimizer now to close the learning loop:

    Run skill-optimizer on $LATEST_JSONL against ~/.claude/skills/$SKILL_TARGET/SKILL.md

That writes skill-improvement/$SKILL_TARGET/${TODAY}-*. Once the diff is produced,
review and apply if scores improve. Then this Stop will pass cleanly.
EOF
    exit 2
fi

# ---- Mulch sync (always best-effort) ---------------------------------------
if command -v mulch >/dev/null 2>&1; then
    if git diff --quiet -- .mulch/ 2>/dev/null && git diff --cached --quiet -- .mulch/ 2>/dev/null; then
        : # no .mulch/ changes — skip silently
    else
        if mulch sync --message "auto: session-close mulch sync" >/dev/null 2>&1; then
            echo "[quality-gates] mulch sync: committed .mulch/ changes." >&2
        fi
    fi
fi

exit 0
