#!/usr/bin/env bash
# print-doc.sh — Download and print a Google Drive/Docs file or public URL
# Usage: cortextos bus print-doc <drive-url|file-id|public-url>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus print-doc "$@"
