#!/usr/bin/env bash
# kb-collections.sh — List knowledge base collections and document counts
#
# Usage:
#   bash bus/kb-collections.sh [--org ORG] [--instance ID]
#
# Env: CTX_ORG, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT, GEMINI_API_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

ORG="${CTX_ORG:-}"
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

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

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Knowledge base not set up. Run: bash bus/kb-setup.sh --org $ORG"
  exit 1
fi

if [[ ! -d "$CHROMADB_DIR" ]]; then
  echo "No collections found. Run kb-ingest.sh first."
  exit 0
fi

export MMRAG_DIR="$KB_ROOT"
export MMRAG_CHROMADB_DIR="$CHROMADB_DIR"
export MMRAG_CONFIG="$KB_ROOT/config.json"
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"

"$VENV_PY" "$MMRAG_PY" collections
