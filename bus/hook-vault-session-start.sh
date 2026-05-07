#!/usr/bin/env bash
# hook-vault-session-start.sh — vault boot inject + MEMORY-03 mistake trigger detection
# UserPromptSubmit hook. Must complete in <5s, idempotent per session.
set -euo pipefail

INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true

AGENT="${CTX_AGENT_NAME:-unknown}"
VAULT_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}/obsidian-vault"
DATE=$(date -u +"%Y-%m-%d")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- MEMORY-03: Negative feedback trigger detection ---
PROMPT_TEXT=$(echo "$INPUT" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    # Try various field names for the user message
    msg = d.get('message','') or d.get('prompt','') or d.get('text','') or str(d)
    print(msg[:500].lower())
except:
    print('')
" 2>/dev/null || echo "")

NEGATIVE_TRIGGERS="kacke|scheiße|falsch|wrong|mist|f you|blödsinn|quatsch|nochmal falsch|wieder falsch|immer noch"
if echo "$PROMPT_TEXT" | grep -qiE "$NEGATIVE_TRIGGERS" 2>/dev/null; then
  MISTAKES_FILE="$VAULT_ROOT/${AGENT}/mistakes.md"
  mkdir -p "$VAULT_ROOT/${AGENT}"
  cat >> "$MISTAKES_FILE" << MISTAKE_EOF
## $(date +"%Y-%m-%d %H:%M") — [AUTO-DETECTED] Negative user feedback
**Was passiert:** User expressed dissatisfaction — trigger words detected in prompt.
**Root cause:** To be filled in by agent after understanding the error.
**Lesson:** Review what went wrong in this interaction and update GUARDRAILS if pattern is new.
**Code-Ref:** Review last tool calls in session
---
MISTAKE_EOF
fi

# --- Boot context injection (first prompt per session only) ---
SESSION_EPOCH="${CTX_SESSION_START_EPOCH:-0}"
LOCK_FILE="/tmp/vault-boot-${AGENT}-${SESSION_EPOCH}.lock"
if [[ ! -f "$LOCK_FILE" ]]; then
  touch "$LOCK_FILE"
  BOOT_FILE="$VAULT_ROOT/agent-shared/READ-ON-BOOT.md"
  ACTIVE_SESSION="$VAULT_ROOT/${AGENT}/working-context.md"
  
  INJECT=""
  [[ -f "$BOOT_FILE" ]] && INJECT=$(cat "$BOOT_FILE" 2>/dev/null | head -25 | sed 's/"/\\"/g' | tr '\n' ' ')
  
  if [[ -n "$INJECT" ]]; then
    RESUME=""
    [[ -f "$ACTIVE_SESSION" ]] && RESUME=" | Working context: $(head -5 "$ACTIVE_SESSION" 2>/dev/null | tail -3 | sed 's/"/\\"/g' | tr '\n' ' ')"
    printf '{"hookSpecificOutput":{"additionalSystemPrompt":"[VAULT-BOOT] %s%s"}}' "$INJECT" "$RESUME"
    exit 0
  fi
fi

echo '{}'
