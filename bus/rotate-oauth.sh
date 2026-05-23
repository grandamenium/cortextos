#!/usr/bin/env bash
# rotate-oauth.sh — wrapper for Node.js CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"
exec node "$CLI" bus rotate-oauth "$@"
