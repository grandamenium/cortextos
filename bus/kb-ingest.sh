#!/usr/bin/env bash
# kb-ingest.sh — Ingest files or directories into the cortextOS knowledge base
#
# Usage:
#   bash bus/kb-ingest.sh <path> [<path>...] [options]
#
# Options:
#   --org ORG          Organization name (required if CTX_ORG not set)
#   --agent AGENT      Agent name (required for --scope private)
#   --scope shared|private  shared = org-wide collection, private = agent-only (default: shared)
#   --collection NAME  Override collection name directly
#   --force            Re-ingest even if already indexed
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
SCOPE="shared"
COLLECTION=""
FORCE=""
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --collection) COLLECTION="$2"; shift 2 ;;
    --force) FORCE="--force"; shift ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "ERROR: at least one path required"
  echo "Usage: bash bus/kb-ingest.sh <path> [<path>...] --org ORG"
  exit 1
fi

# Determine collection name
if [[ -z "$COLLECTION" ]]; then
  if [[ "$SCOPE" == "private" ]]; then
    if [[ -z "$AGENT" ]]; then
      echo "ERROR: --agent or CTX_AGENT_NAME required for --scope private"
      exit 1
    fi
    COLLECTION="agent-${AGENT}"
  else
    COLLECTION="shared-${ORG}"
  fi
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
else
  echo "ERROR: Python venv not found at $VENV_DIR. Run: bash bus/kb-setup.sh --org $ORG" >&2
  exit 1
fi

# Source org secrets for GEMINI_API_KEY
SECRETS_FILE="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -o allexport && source "$SECRETS_FILE" && set +o allexport
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "ERROR: GEMINI_API_KEY not set. Add it to orgs/$ORG/secrets.env"
  exit 1
fi

# Ensure venv exists
if [[ ! -d "$VENV_DIR" ]]; then
  echo "Knowledge base not set up. Run: bash bus/kb-setup.sh --org $ORG"
  exit 1
fi

# Ensure chromadb dir exists
mkdir -p "$CHROMADB_DIR"

# Ensure config.json exists (run setup if missing)
CONFIG_FILE="$KB_ROOT/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config not found — running kb-setup.sh first..."
  bash "$SCRIPT_DIR/kb-setup.sh" --org "$ORG" --instance "$INSTANCE_ID"
fi

# Run ingest
export MMRAG_DIR="$KB_ROOT"
export MMRAG_CHROMADB_DIR="$CHROMADB_DIR"
export MMRAG_CONFIG="$CONFIG_FILE"
export GEMINI_API_KEY

echo "Ingesting into collection: $COLLECTION"
for path in "${PATHS[@]}"; do
  echo "  Source: $path"
done

"$VENV_PY" "$MMRAG_PY" ingest "${PATHS[@]}" \
  --collection "$COLLECTION" \
  ${FORCE}

exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  echo ""
  echo "Ingest complete → collection: $COLLECTION"
else
  echo "Ingest failed (exit $exit_code)"
  exit $exit_code
fi
