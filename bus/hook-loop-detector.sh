#!/usr/bin/env bash
# hook-loop-detector.sh — wrapper for Node.js CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"
exec node "$CLI" bus hook-loop-detector "$@"
