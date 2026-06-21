#!/usr/bin/env bash
# deploy-drift-source-lib.sh — SOURCE-drift materiality classifier for deploy-drift-probe.sh.
#
# WHY: the daemon dist is compiled (tsup) from src/ + build config ONLY. An origin/main
# commit that touches NONE of those inputs (scripts/tests/docs/templates/orgs/bin/...)
# rebuilds to a byte-identical dist = INERT to the running daemon. The probe's SOURCE
# dimension is a SHA-ancestry check (blind to WHAT changed), so it pages PD on those
# inert merges too — PR #66's own scripts-only merge fired a SOURCE page PD had to hand-
# classify NO-OP. This lib decides whether the gap between two commits touches any
# DIST-AFFECTING input, so the probe pages only on material (rebuild-relevant) drift.
# (Same material-change lane as the RESTART content-hash #53 / source_drift dedup #51,
# and the deploy-drift-nondist-no-restart doctrine.)
#
# Unit-tested directly (tests/shell/deploy-drift-source.test.sh).

# DIST_INPUT_PATHS — pathspecs whose change alters the compiled daemon dist. Keep in
# sync with tsup.config.ts entry roots (src/) + the build config tsup/tsc read.
DIST_INPUT_PATHS=(src/ package.json package-lock.json tsup.config.ts tsconfig.json)

# OPS_MATERIAL_PATHS — NON-dist paths whose change does not alter the daemon bundle but
# is still OPERATIONALLY material: an origin/main advance touching them warrants a page,
# NOT an INERT/INFO downgrade. Per PD spec (SYS-DEPLOY-SOT): CI workflow changes "can
# still matter operationally even if not in dist" — silencing them would hide a real
# advance of the deploy/CI surface. Deliberately disjoint from DIST_INPUT_PATHS (a daemon
# rebuild is NOT required for these — the probe pages them with a distinct, honest reason).
OPS_MATERIAL_PATHS=(.github/workflows)

# _delta_paths <repo_root> <commit_a> <commit_b> <pathspec...>
#   Shared core: echoes (one per line) the files differing between the two commits that
#   match the given pathspecs. Empty => no matching delta. On a missing SHA or failed diff
#   it echoes a non-empty sentinel ("?:no-sha" / "?:diff-failed") so the caller treats the
#   gap as MATERIAL — never silently inert.
_delta_paths() {
  local root="$1" a="$2" b="$3"; shift 3
  [ -n "$a" ] && [ -n "$b" ] || { echo "?:no-sha"; return 0; }
  local out rc
  out=$(git -C "$root" diff --name-only "$a" "$b" -- "$@" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then echo "?:diff-failed"; return 0; fi
  printf '%s\n' "$out" | grep -v '^$' || true
}

# dist_material_delta <repo_root> <commit_a> <commit_b>
#   DIST-AFFECTING files differing between the two commits (one per line). Empty output =>
#   the gap is INERT to the daemon dist (no rebuild-relevant change). Sentinel on bad SHA.
dist_material_delta() {
  _delta_paths "$1" "$2" "$3" "${DIST_INPUT_PATHS[@]}"
}

# ops_material_delta <repo_root> <commit_a> <commit_b>
#   OPERATIONALLY-material (non-dist) files differing between the two commits (one per
#   line). Empty output => no operationally-significant non-dist change. Sentinel on bad
#   SHA. Used to keep .github/workflows/** out of the INERT downgrade (page, not silence).
ops_material_delta() {
  _delta_paths "$1" "$2" "$3" "${OPS_MATERIAL_PATHS[@]}"
}

# FMT_DELTA_MAX — how many paths to spell out before collapsing the tail to "+N more".
FMT_DELTA_MAX=6

# fmt_delta_summary <newline-separated-path-list>
#   Renders a path list (as produced by the *_delta functions) into a one-glance triage
#   string: "<count> file(s) [a, b, c, +N more]". Empty input => "0 file(s) []". Keeps the
#   probe's escalation/INFO line carrying the actual matched paths, not just a count
#   (PD SYS-DEPLOY-SOT spec: "emit the matched-path list so triage stays one-glance").
fmt_delta_summary() {
  local list="$1" count shown more
  count=$(printf '%s\n' "$list" | grep -c . )
  if [ "$count" -eq 0 ]; then echo "0 file(s) []"; return 0; fi
  # Join with ", " — awk (not `paste -sd ', '`, which cycles the two delimiter chars
  # alternately and yields "a,b c,d" rather than "a, b, c, d").
  shown=$(printf '%s\n' "$list" | grep . | head -n "$FMT_DELTA_MAX" \
    | awk 'BEGIN{ORS=""} NR>1{print ", "} {print}')
  if [ "$count" -gt "$FMT_DELTA_MAX" ]; then
    more=$((count - FMT_DELTA_MAX))
    echo "${count} file(s) [${shown}, +${more} more]"
  else
    echo "${count} file(s) [${shown}]"
  fi
}
