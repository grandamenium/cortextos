#!/usr/bin/env bash
# ask-codex-remote.sh — dispatch a Codex prompt to wherever the OAuth lives.
#
# Tries local codex first (fastest); falls back to SSH to MacBook
# (where Hari's ChatGPT Pro device-auth landed). Returns a structured envelope
# matching ask-codex.sh so callers can swap interchangeably.
#
# Usage: ask-codex-remote.sh "<prompt>" [--resume]
# Env:
#   CODEX_REMOTE_HOST (default macbook-m4)
#   CODEX_REMOTE_SSH_CONFIG (default /Users/subbu_ai_assistant/.ssh/config_macbook)
#   MAX_OUTPUT_TOKENS (default 5000)
#
# Output: JSON envelope to stdout; full output staged to /tmp/multi-llm-bridge/<task-id>/codex-out.txt

set -uo pipefail

PROMPT="${1:-}"
RESUME_FLAG=""
if [ "${2:-}" = "--resume" ]; then
  RESUME_FLAG="--resume --last"
fi

if [ -z "$PROMPT" ]; then
  echo '{"verdict":"error","error":"missing prompt"}' >&2
  exit 2
fi

REMOTE_HOST="${CODEX_REMOTE_HOST:-macbook-m4}"
SSH_CONFIG="${CODEX_REMOTE_SSH_CONFIG:-/Users/subbu_ai_assistant/.ssh/config_macbook}"
TASK_ID="codex-$(date +%s)-$$"
WORK="/tmp/multi-llm-bridge/$TASK_ID"
mkdir -p "$WORK"
OUT_FILE="$WORK/codex-out.txt"

# Try local first (fast path: no network hop)
LOCAL_CODEX=$(command -v codex 2>/dev/null || ls /Users/subbu_ai_assistant/.local/bin/codex 2>/dev/null | head -1)
if [ -n "$LOCAL_CODEX" ] && [ -f "$HOME/.codex/auth.json" ]; then
  BACKEND="local"
  T0=$(date +%s)
  env -u OPENAI_API_KEY "$LOCAL_CODEX" exec --skip-git-repo-check $RESUME_FLAG "$PROMPT" >"$OUT_FILE" 2>"$WORK/codex.err" &
  CODEX_PID=$!
  wait $CODEX_PID
  RC=$?
  ELAPSED=$(($(date +%s) - T0))
else
  # Fall back to SSH-to-MacBook where the auth lives.
  BACKEND="ssh-remote:$REMOTE_HOST"
  if [ ! -f "$SSH_CONFIG" ]; then
    echo '{"verdict":"error","error":"no local codex auth AND no SSH config at '"$SSH_CONFIG"'"}' >&2
    exit 3
  fi
  T0=$(date +%s)
  # Encode prompt safely via base64 to dodge shell quoting issues
  PROMPT_B64=$(printf '%s' "$PROMPT" | base64 | tr -d '\n')
  ssh -F "$SSH_CONFIG" -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_HOST" \
    "export PATH=/opt/homebrew/bin:\$HOME/.local/bin:\$PATH; cd /tmp && codex exec --skip-git-repo-check $RESUME_FLAG \"\$(echo $PROMPT_B64 | base64 -d)\"" \
    >"$OUT_FILE" 2>"$WORK/codex.err"
  RC=$?
  ELAPSED=$(($(date +%s) - T0))
fi

if [ $RC -ne 0 ]; then
  # Trim error to first 500 chars; JSON-escape it
  ERR=$(head -c 500 < "$WORK/codex.err" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  python3 -c "
import json
print(json.dumps({
    'verdict': 'error',
    'backend': '$BACKEND',
    'task_id': '$TASK_ID',
    'elapsed_s': $ELAPSED,
    'rc': $RC,
    'stderr_excerpt': $ERR,
}, indent=2))
"
  exit 4
fi

# Extract the codex assistant body — codex exec writes a banner, then 'user' block, then 'codex' block, then 'tokens used'.
# Find the 'codex' marker and everything between it and 'tokens used'.
BODY=$(python3 -c "
import re, sys
text = open('$OUT_FILE').read()
# Match the 'codex' line that follows the user input; everything until 'tokens used' or EOF
m = re.search(r'\ncodex\n(.*?)(?:\ntokens used|\Z)', text, re.DOTALL)
if m:
    print(m.group(1).strip())
else:
    print(text.strip())  # fallback: emit the whole transcript
")

# Token count (best-effort regex extraction)
TOKENS=$(grep -oE 'tokens used[[:space:]]*[0-9,]+' "$OUT_FILE" 2>/dev/null | tail -1 | grep -oE '[0-9,]+$' | tr -d ',')

python3 -c "
import json
body = '''$BODY'''
print(json.dumps({
    'verdict': 'ok',
    'backend': '$BACKEND',
    'task_id': '$TASK_ID',
    'elapsed_s': $ELAPSED,
    'tokens_used': int('$TOKENS' or 0),
    'output_path': '$OUT_FILE',
    'body': body[:4000],
    'body_truncated': len(body) > 4000,
}, indent=2))
"
