#!/usr/bin/env bash
# vault-append-mistake.sh — append a lesson-learned entry to agent mistakes.md
# Usage: vault-append-mistake.sh "<title>" "<what-happened>" "<root-cause>" "<lesson>" [<code-ref>]
# Non-interactive, idempotent, completes in <1s.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true

AGENT="${CTX_AGENT_NAME:-unknown}"
VAULT_DIR="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}/obsidian-vault/${AGENT}"
MISTAKES_FILE="$VAULT_DIR/mistakes.md"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

TITLE="${1:-unknown}"
WHAT="${2:-}"
CAUSE="${3:-}"
LESSON="${4:-}"
CODE_REF="${5:-}"

mkdir -p "$VAULT_DIR"

cat >> "$MISTAKES_FILE" << ENTRY_EOF
## ${TIMESTAMP} — ${TITLE}
**Was passiert:** ${WHAT}
**Root cause:** ${CAUSE}
**Lesson:** ${LESSON}
$([ -n "${CODE_REF}" ] && echo "**Code-Ref:** ${CODE_REF}" || true)
---
ENTRY_EOF

echo "Appended mistake to $MISTAKES_FILE"
