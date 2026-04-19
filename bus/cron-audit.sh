#!/usr/bin/env bash
# cron-audit.sh — Audit all agent cron prompts for token efficiency
# Detects inline prompts that should be extracted to skill files.
#
# Usage: bash bus/cron-audit.sh [--org ORG] [--instance ID] [--fix] [--threshold N]
# Env:   CTX_ORG, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT
#
# Without --fix: prints a report of bloated cron prompts
# With --fix:    generates skill files and slims the prompts automatically

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

# Defaults
ORG="${CTX_ORG:-}"
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
FIX=false
THRESHOLD=100  # chars — prompts longer than this get flagged

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    --fix) FIX=true; shift ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

CTX_ROOT="${HOME}/.cortextos/${INSTANCE_ID}"
AGENTS_DIR="${FRAMEWORK_ROOT}/orgs/${ORG}/agents"

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: agents directory not found: $AGENTS_DIR"
  exit 1
fi

TOTAL_FLAGGED=0
TOTAL_FIXED=0
TOTAL_CHARS_SAVED=0

echo "cortextOS Cron Prompt Audit"
echo "  Org: ${ORG}"
echo "  Threshold: ${THRESHOLD} chars"
echo "  Mode: $(${FIX} && echo 'FIX (will generate skills)' || echo 'REPORT ONLY')"
echo ""

for AGENT_DIR in "${AGENTS_DIR}"/*/; do
  AGENT_NAME=$(basename "$AGENT_DIR")
  CONFIG="${AGENT_DIR}/config.json"

  [[ -f "$CONFIG" ]] || continue

  CRON_COUNT=$(jq '.crons | length' "$CONFIG" 2>/dev/null || echo 0)
  [[ "$CRON_COUNT" -eq 0 ]] && continue

  AGENT_FLAGGED=0

  for i in $(seq 0 $((CRON_COUNT - 1))); do
    CRON_NAME=$(jq -r ".crons[$i].name" "$CONFIG")
    CRON_TYPE=$(jq -r ".crons[$i].type // \"recurring\"" "$CONFIG")
    PROMPT=$(jq -r ".crons[$i].prompt" "$CONFIG")
    PROMPT_LEN=${#PROMPT}

    # Skip if already a skill pointer
    if echo "$PROMPT" | grep -qE '^\s*Read.*\.claude/skills/.*/SKILL\.md'; then
      continue
    fi

    # Skip if under threshold
    [[ $PROMPT_LEN -le $THRESHOLD ]] && continue

    TOTAL_FLAGGED=$((TOTAL_FLAGGED + 1))
    AGENT_FLAGGED=$((AGENT_FLAGGED + 1))

    # Derive skill name from cron name
    SKILL_NAME=$(echo "$CRON_NAME" | tr '_' '-')
    SKILL_DIR="${AGENT_DIR}.claude/skills/${SKILL_NAME}"
    SKILL_FILE="${SKILL_DIR}/SKILL.md"

    if [[ $AGENT_FLAGGED -eq 1 ]]; then
      echo "=== ${AGENT_NAME} ==="
    fi

    echo "  [${CRON_NAME}] ${PROMPT_LEN} chars (threshold: ${THRESHOLD})"
    echo "    type: ${CRON_TYPE}, interval: $(jq -r ".crons[$i].interval // .crons[$i].cron // \"?\"" "$CONFIG")"

    if [[ -f "$SKILL_FILE" ]]; then
      echo "    skill: EXISTS at ${SKILL_FILE} (prompt not pointing to it)"
    else
      echo "    skill: MISSING — needs ${SKILL_FILE}"
    fi

    if $FIX; then
      # Create skill file if it doesn't exist
      if [[ ! -f "$SKILL_FILE" ]]; then
        mkdir -p "$SKILL_DIR"

        # Convert the inline prompt into a skill file
        TITLE=$(echo "$CRON_NAME" | tr '-' ' ' | sed 's/\b\(.\)/\u\1/g')
        cat > "$SKILL_FILE" << SKILL_EOF
# ${TITLE} Skill

Auto-generated from inline cron prompt by cron-audit.sh.
Review and refine this skill file, then verify the cron works correctly.

## Workflow

${PROMPT}
SKILL_EOF
        echo "    CREATED: ${SKILL_FILE}"
      fi

      # Slim the cron prompt
      NEW_PROMPT="Read and follow .claude/skills/${SKILL_NAME}/SKILL.md"
      OLD_LEN=$PROMPT_LEN
      NEW_LEN=${#NEW_PROMPT}
      SAVED=$((OLD_LEN - NEW_LEN))
      TOTAL_CHARS_SAVED=$((TOTAL_CHARS_SAVED + SAVED))
      TOTAL_FIXED=$((TOTAL_FIXED + 1))

      # Update config.json in place
      jq --arg idx "$i" --arg prompt "$NEW_PROMPT" \
        '.crons[($idx | tonumber)].prompt = $prompt' "$CONFIG" > "${TMPDIR:-/tmp}/_cron_audit.json" \
        && mv "${TMPDIR:-/tmp}/_cron_audit.json" "$CONFIG"

      echo "    FIXED: ${OLD_LEN} → ${NEW_LEN} chars (saved ${SAVED})"
    fi
  done

  if [[ $AGENT_FLAGGED -gt 0 ]]; then
    echo ""
  fi
done

echo "--- Summary ---"
echo "  Agents scanned: $(ls -d "${AGENTS_DIR}"/*/ 2>/dev/null | wc -l | tr -d ' ')"
echo "  Cron prompts flagged: ${TOTAL_FLAGGED}"
if $FIX; then
  echo "  Prompts fixed: ${TOTAL_FIXED}"
  echo "  Total chars saved: ${TOTAL_CHARS_SAVED}"
fi

if [[ $TOTAL_FLAGGED -eq 0 ]]; then
  echo "  All cron prompts are within threshold. No action needed."
fi
