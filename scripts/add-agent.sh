#!/usr/bin/env bash
# Wrapper used by shell e2e tests to create agents through the local CLI.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT/dist/cli.js" ]; then
    exec node "$ROOT/dist/cli.js" add-agent "$@"
fi

exec "$ROOT/node_modules/.bin/tsx" "$ROOT/src/cli/index.ts" add-agent "$@"
