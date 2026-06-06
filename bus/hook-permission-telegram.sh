#!/usr/bin/env bash
# hook-permission-telegram.sh - Blocking PermissionRequest hook
# Forwards permission prompts to Telegram with Approve/Deny inline buttons.
# Polls for a response file written by fast-checker when the user taps a button.
# Timeout: 1800s (30 min, deny by default). Settings.json timeout should be 1860s.

set -euo pipefail

# Read stdin FIRST before anything that might consume it
INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true
TEMPLATE_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT="${CTX_AGENT_NAME:-$(basename "$(pwd)")}"

# Source .env for BOT_TOKEN and CHAT_ID
ENV_FILE="${CTX_AGENT_DIR:-.}/.env"
{ set +x; } 2>/dev/null
if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
elif [[ -f ".env" ]]; then
    set -a; source ".env"; set +a
fi

if [[ -z "${BOT_TOKEN:-}" ]] || [[ -z "${CHAT_ID:-}" ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"No Telegram credentials configured for remote approval"}}}'
    exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

# ExitPlanMode is handled by hook-planmode-telegram.sh - skip here
if [[ "$TOOL_NAME" == "ExitPlanMode" || "$TOOL_NAME" == "AskUserQuestion" ]]; then
    exit 0
fi

# Auto-approve edits to the agent's OWN .claude/ directory (configs/skills it
# manages at runtime). Precise path containment — NOT a substring match — because
# under bypassPermissions this hook is the only approval gate.
#   - Bash is never auto-approved: a command string can't be proven to touch only
#     .claude/ (e.g. `rm -rf ~; ls .claude/` contains the substring) (#1).
#   - Edit/Write only when file_path resolves inside <agentDir>/.claude/, which
#     defeats ../ traversal and other/arbitrary .claude/ directories (#18).
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
    # Require an explicit trust boundary — no pwd fallback, so the auto-approve
    # scope can't drift to whatever directory the hook happened to start in.
    # `realpath -m` is GNU-specific; on shells without it (BSD/macOS) skip
    # auto-approval entirely and let the request go to the human gate (safe).
    if [[ -n "$FILE_PATH" && -n "${CTX_AGENT_DIR:-}" ]] && realpath -m / >/dev/null 2>&1; then
        AGENT_DIR="$CTX_AGENT_DIR"
        # Reject a symlinked .claude root: it would redirect the gate elsewhere.
        if [[ ! -L "${AGENT_DIR}/.claude" ]]; then
            CLAUDE_ROOT="$(realpath -m "${AGENT_DIR}/.claude")"
            case "$FILE_PATH" in
                /*) ABS_PATH="$FILE_PATH" ;;
                *)  ABS_PATH="${AGENT_DIR}/${FILE_PATH}" ;;
            esac
            RESOLVED="$(realpath -m "$ABS_PATH")"
            if [[ "$RESOLVED" == "$CLAUDE_ROOT" || "$RESOLVED" == "$CLAUDE_ROOT/"* ]]; then
                echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
                exit 0
            fi
        fi
    fi
fi

# Build a human-readable summary
case "$TOOL_NAME" in
    Edit)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"' 2>/dev/null)
        OLD_STR=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""' 2>/dev/null | head -c 300)
        NEW_STR=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""' 2>/dev/null | head -c 300)
        TOOL_SUMMARY="File: ${FILE_PATH}

- ${OLD_STR}
+ ${NEW_STR}"
        ;;
    Write)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"' 2>/dev/null)
        CONTENT_PREVIEW=$(echo "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null | head -c 300)
        TOOL_SUMMARY="File: ${FILE_PATH}

${CONTENT_PREVIEW}"
        ;;
    Bash)
        # Show up to 1500 chars (was 200) so a benign-looking prefix can't hide a
        # payload from the human approver; mark truncation explicitly (#39).
        CMD_FULL=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
        CMD=$(printf '%s' "$CMD_FULL" | head -c 1500)
        if [[ ${#CMD_FULL} -gt ${#CMD} ]]; then
            TOOL_SUMMARY="Command: ${CMD}
…(preview truncated — the FULL command, not just this preview, runs if you approve)"
        else
            TOOL_SUMMARY="Command: ${CMD}"
        fi
        ;;
    *)
        TOOL_SUMMARY=$(echo "$INPUT" | jq -r '.tool_input // {}' 2>/dev/null | jq -c '.' 2>/dev/null | head -c 200)
        ;;
esac

# Generate unique ID for this request
UNIQUE_ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
HOOK_STATE_DIR="${CTX_ROOT:-${HOME}/.cortextos/default}/state/${AGENT}"
mkdir -p "${HOOK_STATE_DIR}"
RESPONSE_FILE="${HOOK_STATE_DIR}/hook-response-${UNIQUE_ID}.json"

cleanup() {
    rm -f "$RESPONSE_FILE"
}
trap cleanup EXIT

# Sanitize text for Telegram code blocks (escape triple backticks)
sanitize_code_block() {
    echo "$1" | sed "s/\`\`\`/\`\`\\\\\`/g"
}

MESSAGE="PERMISSION REQUEST
Agent: ${AGENT}
Tool: ${TOOL_NAME}

\`\`\`
$(sanitize_code_block "${TOOL_SUMMARY}")
\`\`\`"

# Truncate if over Telegram's 4096 char limit
if [[ ${#MESSAGE} -gt 3800 ]]; then
    MESSAGE="${MESSAGE:0:3800}...(truncated)"
fi

KEYBOARD=$(jq -n -c \
    --arg allow "perm_allow_${UNIQUE_ID}" \
    --arg deny "perm_deny_${UNIQUE_ID}" \
    '{inline_keyboard: [[
        {text: "Approve", callback_data: $allow},
        {text: "Deny", callback_data: $deny}
    ]]}')

bash "${TEMPLATE_ROOT}/bus/send-telegram.sh" "${CHAT_ID}" "${MESSAGE}" "${KEYBOARD}" > /dev/null 2>&1 || {
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Failed to send permission request to Telegram"}}}'
    exit 0
}

# Poll for response file
ELAPSED=0
TIMEOUT=1800
POLL_INTERVAL=2

while [[ $ELAPSED -lt $TIMEOUT ]]; do
    if [[ -f "$RESPONSE_FILE" ]]; then
        DECISION=$(jq -r '.decision // "deny"' "$RESPONSE_FILE" 2>/dev/null || echo "deny")

        if [[ "$DECISION" == "allow" ]]; then
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        else
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by user via Telegram"}}}'
        fi
        exit 0
    fi

    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Timeout - deny and notify
bash "${TEMPLATE_ROOT}/bus/send-telegram.sh" "${CHAT_ID}" "Permission request TIMED OUT (auto-denied): ${TOOL_NAME}" > /dev/null 2>&1 || true

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Timed out waiting for Telegram approval (30m)"}}}'
