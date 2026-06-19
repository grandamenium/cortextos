#!/usr/bin/env bash
# deploy-drift-hold-lib.sh — RESTART-HOLD classifier for deploy-drift-probe.sh.
#
# WHY (SYS-DEPLOY-SOT, dirty-tree class): a committed-SHA range diff (origin/main vs
# dist/.build-sha) is BLIND to a dist rebuilt from a DIRTY working tree. When the
# RESTART dimension fires (on-disk dist/daemon.js is ahead of what the running daemon
# loaded) but that dist was built while src/daemon/ had UNCOMMITTED changes, a restart
# (deliberate OR crash-recovery) would load UNREVIEWED in-progress daemon code, while
# the committed-SHA diff shows EMPTY and the drift looks like routine "recompile-noise".
# REAL incident 2026-06-19: improver rebuilt dist from uncommitted SYS-1M-DETECT
# (detectModelBillingConfigError in src/daemon/agent-process.ts) -> dist carried
# unreviewed daemon code; a "no committed src delta -> inert" call was WRONG.
# LESSON: verify the running ARTIFACT (dist content), not just committed-SHA diffs
# (running-code == armed-code).
#
# Sourced by the probe; unit-tested directly (tests/shell/deploy-drift-hold.test.sh).

# list_dirty_daemon_files <framework_root>
#   Echoes (one per line) each tracked src/daemon/ path with an UNCOMMITTED change
#   (staged or unstaged modify/add). Empty => daemon src is clean.
list_dirty_daemon_files() {
  git -C "$1" status --porcelain -- src/daemon/ 2>/dev/null | awk '$1 ~ /[MA]/ {print $2}'
}

# trace_uncommitted_daemon_symbols <framework_root> <daemon_js>
#   Echoes (one per line) each net-new declared identifier from the uncommitted
#   src/daemon/ diff (vs HEAD) that is ALSO present in the built daemon_js — i.e.
#   proof the RUNNING dist literally carries uncommitted daemon source. Empty output
#   => no dirty daemon src, or none of its new symbols reached the dist. Identifiers
#   shorter than 8 chars are ignored to avoid coincidental matches against the bundle.
trace_uncommitted_daemon_symbols() {
  local root="$1" djs="$2"
  [ -d "$root" ] && [ -f "$djs" ] || return 0
  [ -n "$(list_dirty_daemon_files "$root")" ] || return 0
  local cands tok
  # Added lines (vs HEAD, staged+unstaged) → declared identifier names.
  cands=$(git -C "$root" diff HEAD -- src/daemon/ 2>/dev/null \
    | grep -E '^\+' | grep -vE '^\+\+\+' \
    | grep -oE '(function|const|let|class)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]+' \
    | grep -oE '[A-Za-z_$][A-Za-z0-9_$]*$' | sort -u)
  for tok in $cands; do
    [ ${#tok} -ge 8 ] || continue
    grep -q -- "$tok" "$djs" 2>/dev/null && echo "$tok"
  done
}
