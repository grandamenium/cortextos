#!/usr/bin/env bash
# set-wrdrobe-branch.sh — wrapper for Node.js CLI
# Usage: set-wrdrobe-branch.sh <branch> [--repo-url <url>] [--conf-path <path>]
#
# Writes the named branch to ~/wrdrobe-branch.conf (or the path passed via
# --conf-path / $CTX_WRDROBE_BRANCH_CONF). The Mini autopull picks up the
# change on its next cycle (~15s). Validates the branch exists on the
# WRDROBE remote before writing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <branch> [--repo-url <url>] [--conf-path <path>]" >&2
  exit 2
fi

BRANCH="$1"
shift

exec node "$CLI" bus set-wrdrobe-branch "$BRANCH" "$@"
