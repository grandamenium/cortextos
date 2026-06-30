#!/usr/bin/env bash
# kb-query.sh — Query the cortextOS knowledge base
#
# Usage:
#   bash bus/kb-query.sh "<question>" [options]
#
# Options:
#   --org ORG          Organization name (required if CTX_ORG not set)
#   --agent AGENT      Agent name (for --scope private)
#   --scope shared|private|all  Which collection(s) to search (default: all)
#   --collection NAME  Override collection name directly
#   --top-k N          Number of results to return (default: 5)
#   --threshold F      Minimum similarity score 0.0-1.0 (default: 0.5)
#   --json             Output JSON instead of plain text
#   --instance ID      Instance ID (default: default)
#
# Env: CTX_ORG, CTX_AGENT_NAME, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT, GEMINI_API_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

# Defaults
ORG="${CTX_ORG:-}"
AGENT="${CTX_AGENT_NAME:-}"
SCOPE="all"
COLLECTION=""
TOP_K=5
THRESHOLD=0.5
JSON_FLAG=""
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
QUESTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --collection) COLLECTION="$2"; shift 2 ;;
    --top-k) TOP_K="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --json) JSON_FLAG="--json"; shift ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) QUESTION="$1"; shift ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

if [[ -z "$QUESTION" ]]; then
  echo "ERROR: question required"
  echo "Usage: bash bus/kb-query.sh 'your question' --org ORG"
  exit 1
fi

# Determine collection
if [[ -z "$COLLECTION" ]]; then
  case "$SCOPE" in
    private)
      if [[ -z "$AGENT" ]]; then
        echo "ERROR: --agent or CTX_AGENT_NAME required for --scope private"
        exit 1
      fi
      COLLECTION="agent-${AGENT}"
      ;;
    shared)
      COLLECTION="shared-${ORG}"
      ;;
    all)
      # Query both; merge results (query shared first, then private if agent set)
      COLLECTION=""
      ;;
  esac
fi

# Paths
KB_ROOT="$HOME/.cortextos/$INSTANCE_ID/orgs/$ORG/knowledge-base"
CHROMADB_DIR="$KB_ROOT/chromadb"
VENV_DIR="$FRAMEWORK_ROOT/knowledge-base/venv"
MMRAG_PY="$FRAMEWORK_ROOT/knowledge-base/scripts/mmrag.py"

# Resolve platform-specific venv paths (Windows uses Scripts/python.exe, Unix uses bin/python3)
if [[ -x "$VENV_DIR/Scripts/python.exe" ]]; then
  VENV_PY="$VENV_DIR/Scripts/python.exe"
elif [[ -x "$VENV_DIR/bin/python3" ]]; then
  VENV_PY="$VENV_DIR/bin/python3"
elif [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PY="$VENV_DIR/bin/python"
fi

# Source org secrets
SECRETS_FILE="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -o allexport && source "$SECRETS_FILE" && set +o allexport
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "ERROR: GEMINI_API_KEY not set. Add it to orgs/$ORG/secrets.env"
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Knowledge base not set up. Run: bash bus/kb-setup.sh --org $ORG"
  exit 1
fi

export MMRAG_DIR="$KB_ROOT"
export MMRAG_CHROMADB_DIR="$CHROMADB_DIR"
export MMRAG_CONFIG="$KB_ROOT/config.json"
export GEMINI_API_KEY

run_query() {
  local col="$1"
  "$VENV_PY" "$MMRAG_PY" query "$QUESTION" \
    --collection "$col" \
    --top-k "$TOP_K" \
    --threshold "$THRESHOLD" \
    ${JSON_FLAG}
}

if [[ -n "$COLLECTION" ]]; then
  # Single collection query (redirect Python warnings to /dev/null)
  run_query "$COLLECTION" 2>/dev/null
else
  # "all" scope: query shared + agent-private if agent set
  run_query "shared-${ORG}" 2>/dev/null || true
  if [[ -n "$AGENT" ]]; then
    run_query "agent-${AGENT}" 2>/dev/null || true
  fi
fi
