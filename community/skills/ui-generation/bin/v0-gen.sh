#!/usr/bin/env bash
# v0-gen.sh — Mode A of ui-generation skill (STUB until V0_API_KEY lands)
#
# Activates when:
#   1. Hari provides V0_API_KEY (v0.dev Premium subscription required, $20/mo)
#   2. SDK installed: `pip install v0-sdk` OR `npm install v0`
#   3. Stub replaced with SDK-driven impl
#
# See community/skills/ui-generation/SKILL.md §Mode A.

set -uo pipefail

if [ -z "${V0_API_KEY:-}" ]; then
  echo '{"verdict":"error","error":"V0_API_KEY not set — see SKILL.md §Mode A for setup"}' >&2
  exit 3
fi

echo '{"verdict":"stub","error":"Mode A not yet wired; SDK install + impl pending Hari V0_API_KEY confirmation"}' >&2
exit 1
