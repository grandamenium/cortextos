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

# dist_material_delta <repo_root> <commit_a> <commit_b>
#   Echoes (one per line) the DIST-AFFECTING files that differ between the two commits.
#   Empty output => the gap is INERT to the daemon dist (no rebuild-relevant change).
#   On a missing SHA or a failed diff it echoes a non-empty sentinel ("?:no-sha" /
#   "?:diff-failed") so the caller treats the gap as MATERIAL — never silently inert.
dist_material_delta() {
  local root="$1" a="$2" b="$3"
  [ -n "$a" ] && [ -n "$b" ] || { echo "?:no-sha"; return 0; }
  local out rc
  out=$(git -C "$root" diff --name-only "$a" "$b" -- "${DIST_INPUT_PATHS[@]}" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then echo "?:diff-failed"; return 0; fi
  printf '%s\n' "$out" | grep -v '^$' || true
}
