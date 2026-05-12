#!/usr/bin/env bash
# Smoke-test the Cortex -> Codex dispatch lane without exposing secrets.
#
# Default mode runs both checks:
#   1. Direct Mac Codex dispatcher check.
#   2. Cortex bus computer-use check over SSH with fallback disabled.
#
# Useful overrides:
#   DIRECT_ONLY=1 scripts/smoke-codex-dispatch.sh
#   BUS_ONLY=1 SSH_HOST=gregs-mac scripts/smoke-codex-dispatch.sh
#   ALLOW_FALLBACK=1 scripts/smoke-codex-dispatch.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DISPATCH_SCRIPT="${DISPATCH_SCRIPT:-/Users/gregharned/work/team-brain/scripts/codex-dispatch.sh}"
CORTEXTOS_CLI="${CORTEXTOS_CLI:-$ROOT/dist/cli.js}"
SSH_HOST="${SSH_HOST:-gregs-mac}"
TIMEOUT="${TIMEOUT:-120}"
DIRECT_ONLY="${DIRECT_ONLY:-0}"
BUS_ONLY="${BUS_ONLY:-0}"
ALLOW_FALLBACK="${ALLOW_FALLBACK:-0}"

DIRECT_SENTINEL="CORTEXTOS_CODEX_DIRECT_OK"
BUS_SENTINEL="CORTEXTOS_CODEX_BUS_OK"

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing $label: $path" >&2
    exit 1
  fi
}

require_executable() {
  local path="$1"
  local label="$2"
  if [[ ! -x "$path" ]]; then
    echo "not executable $label: $path" >&2
    exit 1
  fi
}

assert_contains() {
  local output="$1"
  local sentinel="$2"
  local label="$3"
  if ! grep -Fq "$sentinel" <<<"$output"; then
    echo "$label did not return sentinel $sentinel" >&2
    echo "---- output ----" >&2
    printf '%s\n' "$output" >&2
    echo "----------------" >&2
    exit 1
  fi
}

run_direct() {
  require_executable "$DISPATCH_SCRIPT" "Codex dispatcher"

  echo "== direct Codex dispatcher =="
  local output
  output="$("$DISPATCH_SCRIPT" --no-plugin --timeout "$TIMEOUT" \
    "Return exactly $DIRECT_SENTINEL and do not edit files.")"
  assert_contains "$output" "$DIRECT_SENTINEL" "direct dispatcher"
  printf '%s\n' "$output"
}

run_bus() {
  require_file "$CORTEXTOS_CLI" "Cortex CLI"

  echo "== Cortex bus computer-use =="
  local args=(
    "$CORTEXTOS_CLI"
    bus
    computer-use
    --no-plugin
    --timeout "$TIMEOUT"
    --ssh-host "$SSH_HOST"
    --dispatch-script "$DISPATCH_SCRIPT"
  )

  if [[ "$ALLOW_FALLBACK" != "1" ]]; then
    args+=(--disable-fallback)
  fi

  local output
  output="$(node "${args[@]}" "Return exactly $BUS_SENTINEL and do not edit files.")"
  assert_contains "$output" "$BUS_SENTINEL" "bus computer-use"
  printf '%s\n' "$output"
}

if [[ "$BUS_ONLY" != "1" ]]; then
  run_direct
fi

if [[ "$DIRECT_ONLY" != "1" ]]; then
  run_bus
fi

