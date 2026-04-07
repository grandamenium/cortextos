#!/usr/bin/env bash
# kb-setup.sh — Initialize the cortextOS knowledge base for an org
# Creates the Python venv and ChromaDB directory structure.
#
# Usage: bash bus/kb-setup.sh [--org ORG] [--instance ID]
# Env:   CTX_ORG, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT, GEMINI_API_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

# Resolve args / env
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

# Paths
KB_ROOT="$HOME/.cortextos/$INSTANCE_ID/orgs/$ORG/knowledge-base"
CHROMADB_DIR="$KB_ROOT/chromadb"
VENV_DIR="$FRAMEWORK_ROOT/knowledge-base/venv"
MMRAG_PY="$FRAMEWORK_ROOT/knowledge-base/scripts/mmrag.py"
REQS="$FRAMEWORK_ROOT/knowledge-base/scripts/requirements.txt"

echo "Setting up cortextOS knowledge base"
echo "  Org: $ORG"
echo "  Instance: $INSTANCE_ID"
echo "  ChromaDB: $CHROMADB_DIR"
echo "  Venv: $VENV_DIR"
echo ""

# Create ChromaDB directory
mkdir -p "$CHROMADB_DIR"
echo "  [OK] ChromaDB directory created"

# Create Python venv if not present
if [[ ! -d "$VENV_DIR" ]]; then
  echo "  Creating Python venv..."
  python3 -m venv "$VENV_DIR"
  echo "  [OK] Venv created"
else
  echo "  [OK] Venv already exists"
fi

# Resolve platform-specific venv paths (Windows uses Scripts/, Unix uses bin/)
if [[ -d "$VENV_DIR/Scripts" ]]; then
  VENV_BIN="$VENV_DIR/Scripts"
else
  VENV_BIN="$VENV_DIR/bin"
fi

# Install/upgrade dependencies
echo "  Installing Python dependencies..."
"$VENV_BIN/pip" install --quiet --upgrade pip 2>/dev/null || true
"$VENV_BIN/pip" install --quiet -r "$REQS"
echo "  [OK] Dependencies installed"

# Validate mmrag.py is accessible
if [[ ! -f "$MMRAG_PY" ]]; then
  echo "  ERROR: mmrag.py not found at $MMRAG_PY"
  exit 1
fi
echo "  [OK] mmrag.py present"

# Create mmrag config.json if it doesn't exist (mmrag.py requires it to exist)
CONFIG_FILE="$KB_ROOT/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "embedding_model": "gemini-embedding-2-preview",
  "embedding_dimensions": 3072,
  "gemini_model": "gemini-2.5-flash",
  "text_chunk_size": 1000,
  "text_chunk_overlap": 200,
  "similarity_threshold": 0.5,
  "default_collection": "shared"
}
EOF
  echo "  [OK] mmrag config.json created"
else
  echo "  [OK] mmrag config.json already exists"

  # Migrate stale embedding model names (text-embedding-004 was shut down 2026-01-14)
  if grep -qE '"embedding_model"\s*:\s*"(models/text-embedding-004|text-embedding-004)"' "$CONFIG_FILE" 2>/dev/null; then
    sed -i.bak 's/"models\/text-embedding-004"/"gemini-embedding-001"/g; s/"text-embedding-004"/"gemini-embedding-001"/g' "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.bak"
    echo "  [MIGRATED] embedding_model updated to gemini-embedding-001 (text-embedding-004 was shut down)"
  fi
fi

# Test import
MMRAG_DIR="$KB_ROOT" \
MMRAG_CHROMADB_DIR="$CHROMADB_DIR" \
MMRAG_CONFIG="$CONFIG_FILE" \
"$VENV_BIN/python3" -c "import chromadb; import google.genai; print('  [OK] Core imports work')" 2>/dev/null || \
"$VENV_BIN/python" -c "import chromadb; import google.genai; print('  [OK] Core imports work')"

echo ""
echo "Knowledge base ready for org: $ORG"
echo ""
echo "  Next steps:"
echo "    1. Add GEMINI_API_KEY to orgs/$ORG/secrets.env"
echo "    2. Run: bash bus/kb-ingest.sh /path/to/docs --org $ORG"
echo "    3. Query: bash bus/kb-query.sh 'your question' --org $ORG"
