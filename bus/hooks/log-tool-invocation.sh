#!/usr/bin/env bash
# HIGH-2 Phase 1: log-only PreToolUse hook.
# Fires before every Claude Code tool call. Logs tool name, agent, and args
# summary. Never exits non-zero — blocking enforcement is Phase 2.
#
# Claude Code passes the hook payload as JSON on stdin:
#   { "tool_name": "...", "tool_input": { ... } }

AGENT="${CTX_AGENT_NAME:-unknown}"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
LOG_DIR="$CTX_ROOT/logs/$AGENT"
LOG_FILE="$LOG_DIR/tool-invocations.log"

mkdir -p "$LOG_DIR"

PAYLOAD=$(cat 2>/dev/null || true)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

if [[ -n "$PAYLOAD" ]] && command -v node &>/dev/null; then
  # Let Node produce the entire JSONL line to avoid shell quoting issues.
  LOG_ENTRY=$(printf '%s' "$PAYLOAD" | env TS="$TIMESTAMP" AGENT="$AGENT" node -e "
const ts = process.env.TS;
const agent = process.env.AGENT;
let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(raw);
    const tool = typeof d.tool_name === 'string' ? d.tool_name : 'unknown';
    const inp = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
    const keys = Object.keys(inp);
    let args = '';
    if (keys.length > 0) {
      const k = keys[0];
      args = k + '=' + JSON.stringify(String(inp[k]).slice(0, 80));
    }
    process.stdout.write(JSON.stringify({ ts, agent, tool, args }) + '\n');
  } catch(e) {
    process.stdout.write(JSON.stringify({ ts, agent, tool: 'unknown', args: '' }) + '\n');
  }
});
" 2>/dev/null)

  if [[ -n "$LOG_ENTRY" ]]; then
    printf '%s\n' "$LOG_ENTRY" >> "$LOG_FILE"
    exit 0
  fi
fi

# Fallback: plain log entry when Node is unavailable or fails.
printf '{"ts":"%s","agent":"%s","tool":"unknown","args":""}\n' \
  "$TIMESTAMP" "$AGENT" >> "$LOG_FILE"

exit 0
