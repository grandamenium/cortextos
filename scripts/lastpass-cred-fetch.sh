#!/usr/bin/env bash
set -euo pipefail

# Fetch one LastPass credential from an already-unlocked LastPass CLI session.
#
# Contract:
# - argv[1] is a service/item name.
# - stdout is the credential only.
# - stderr is status/errors only.
# - never prompts for or stores the LastPass master password.
#
# This script is intentionally CLI-only. It must not open Chrome or use
# osascript on Greg's Mac; browser credential workflows belong on an approved
# Orgo/Codex-CU path or a human-approved manual step.

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "usage: $0 <service>" >&2
  exit 64
fi

if [[ "$SERVICE" =~ [^A-Za-z0-9._/@:+-] ]]; then
  echo "refusing service name with unsupported characters: $SERVICE" >&2
  exit 64
fi

LPASS_ENTRY_PREFIX="${LPASS_ENTRY_PREFIX:-}"
ENTRY="${LPASS_ENTRY_PREFIX}${SERVICE}"

if command -v lpass >/dev/null 2>&1; then
  if lpass status >/dev/null 2>&1; then
    exec lpass show --password "$ENTRY"
  fi
fi

echo "LastPass CLI is unavailable or locked; Chrome/osascript fallback is disabled by STACK-12 Mac quarantine." >&2
exit 69
