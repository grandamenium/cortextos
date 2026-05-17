#!/usr/bin/env bash
# ask-codex.sh — invoke OpenAI Codex CLI on a single prompt, return structured envelope.
#
# Usage: ask-codex.sh "<prompt>" [--resume]
# Env: OPENAI_API_KEY (required), MAX_OUTPUT_TOKENS (default 5000)
#
# Output: JSON envelope to stdout, full output staged to /tmp/multi-llm-bridge/<task-id>/codex-out.txt

set -uo pipefail

PROMPT="${1:-}"
RESUME=""
if [ "${2:-}" = "--resume" ]; then
  RESUME="--resume --last"
fi

if [ -z "$PROMPT" ]; then
  echo '{"verdict":"error","error":"missing prompt"}' >&2
  exit 2
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo '{"verdict":"error","error":"OPENAI_API_KEY not set"}' >&2
  exit 3
fi

if ! command -v codex >/dev/null 2>&1; then
  echo '{"verdict":"error","error":"codex CLI not found in PATH (install: npm i -g @openai/codex)"}' >&2
  exit 4
fi

TASK_ID="codex-$(date +%s)-$$"
TASK_DIR="/tmp/multi-llm-bridge/${TASK_ID}"
mkdir -p "$TASK_DIR"

OUT_FILE="${TASK_DIR}/codex-out.txt"
JSONL_FILE="${TASK_DIR}/codex.jsonl"

T0=$(date +%s)

# Run codex exec — JSON mode + workspace-write sandbox so it can author files
# in cwd if asked. Caller (Claude) is responsible for reviewing what got written.
printf '%s\n' "$PROMPT" | \
  codex exec --json --sandbox workspace-write --skip-git-repo-check $RESUME \
    > "$JSONL_FILE" 2>"${TASK_DIR}/codex.err"
EXIT_CODE=$?

T1=$(date +%s)
ELAPSED=$((T1 - T0))

# Extract turn.completed event + count tokens. Fall back gracefully.
if [ -s "$JSONL_FILE" ]; then
  TOKENS_IN=$(python3 -c "
import json, sys
total_in = 0
total_out = 0
output = ''
try:
    with open('$JSONL_FILE') as f:
        for line in f:
            try:
                e = json.loads(line)
                if e.get('type') == 'turn.completed':
                    usage = e.get('usage', {})
                    total_in += usage.get('input_tokens', 0)
                    total_out += usage.get('output_tokens', 0)
                if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message':
                    output += e.get('item', {}).get('text', '')
            except: pass
    print(f'{total_in}|{total_out}|{output}')
except Exception as ex:
    print('0|0|')
" 2>/dev/null)

  IN_TOKENS=$(printf '%s' "$TOKENS_IN" | cut -d'|' -f1)
  OUT_TOKENS=$(printf '%s' "$TOKENS_IN" | cut -d'|' -f2)
  OUTPUT_TEXT=$(printf '%s' "$TOKENS_IN" | cut -d'|' -f3-)
  printf '%s' "$OUTPUT_TEXT" > "$OUT_FILE"
else
  IN_TOKENS=0
  OUT_TOKENS=0
  printf '%s' "" > "$OUT_FILE"
fi

SUMMARY=$(head -c 500 "$OUT_FILE" 2>/dev/null || true)
VERDICT="ok"
ERROR_MSG=""
if [ "$EXIT_CODE" -ne 0 ]; then
  VERDICT="error"
  ERROR_MSG=$(head -c 500 "${TASK_DIR}/codex.err" 2>/dev/null || echo "exit=$EXIT_CODE")
fi

python3 -c "
import json
env = {
  'provider': 'codex',
  'task_id': '$TASK_ID',
  'elapsed_s': $ELAPSED,
  'tokens_in': $IN_TOKENS,
  'tokens_out': $OUT_TOKENS,
  'output_summary': '''$SUMMARY''',
  'output_path': '$OUT_FILE',
  'verdict': '$VERDICT',
  'error': '''$ERROR_MSG'''
}
print(json.dumps(env, indent=2))
"
