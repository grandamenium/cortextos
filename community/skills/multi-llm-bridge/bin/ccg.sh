#!/usr/bin/env bash
# ccg.sh — Claude+Codex+Gemini parallel dispatch.
#
# Calls ask-codex.sh AND ask-gemini.sh in parallel on the same prompt, captures
# both envelopes, returns a combined JSON for the caller (Claude orchestrator)
# to review/synthesize.
#
# Usage: ccg.sh "<prompt>"
# Env: OPENAI_API_KEY + GEMINI_API_KEY (both required)

set -uo pipefail

PROMPT="${1:-}"
if [ -z "$PROMPT" ]; then
  echo '{"verdict":"error","error":"missing prompt"}' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_ID="ccg-$(date +%s)-$$"
TASK_DIR="/tmp/multi-llm-bridge/${TASK_ID}"
mkdir -p "$TASK_DIR"

# Dispatch in parallel
"$SCRIPT_DIR/ask-codex.sh" "$PROMPT" > "${TASK_DIR}/codex-env.json" 2>"${TASK_DIR}/codex.err" &
CODEX_PID=$!

# Gemini sibling — if ask-gemini.sh exists, use it; otherwise return placeholder
if [ -x "$SCRIPT_DIR/ask-gemini.sh" ]; then
  "$SCRIPT_DIR/ask-gemini.sh" "$PROMPT" > "${TASK_DIR}/gemini-env.json" 2>"${TASK_DIR}/gemini.err" &
  GEMINI_PID=$!
else
  echo '{"provider":"gemini","verdict":"error","error":"ask-gemini.sh not implemented"}' > "${TASK_DIR}/gemini-env.json"
  GEMINI_PID=""
fi

wait "$CODEX_PID" 2>/dev/null || true
[ -n "$GEMINI_PID" ] && wait "$GEMINI_PID" 2>/dev/null || true

python3 -c "
import json
codex = json.load(open('${TASK_DIR}/codex-env.json')) if '''$(test -s "${TASK_DIR}/codex-env.json" && echo y || echo n)''' == 'y' else {'verdict':'error','error':'codex empty output'}
gemini = json.load(open('${TASK_DIR}/gemini-env.json'))
out = {
  'task_id': '$TASK_ID',
  'codex': codex,
  'gemini': gemini,
  'synthesis_instruction': 'Caller (Claude orchestrator) reviews both envelopes and picks/synthesizes the answer.'
}
print(json.dumps(out, indent=2))
"
