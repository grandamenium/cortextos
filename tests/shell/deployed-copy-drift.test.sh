#!/bin/bash
# Regression test for SYS-DEPLOY-SOT (deployed-copy class): sync-deployed-scripts.sh
# keeps launchd deployed-copies in lock-step with their repo source-of-truth.
#
# Root incident: quota-watchdog ran a deployed copy under ${CTX_ROOT}/scripts/ that
# silently lagged the repo false-pause guard ~2wks (no auto-sync) — the running-code
# != tested-code class behind the 2026-06-18 fleet false-pause.
#
# Criteria:
#   (1) in-sync   → check exits 0, reports no drift
#   (2) drift     → check exits 1, names the drifted file
#   (3) apply     → copies SoT over the deployed path, exec bit preserved, then clean
#   (4) missing   → a registered deployed file that does not exist is drift; apply creates it
#   (5) orphan    → SoT == NONE is skipped (never synced, never a hard failure)
#
# Uses --from-worktree mode against fixtures (no git/origin/main needed).
# Usage: bash deployed-copy-drift.test.sh <sync-deployed-scripts.sh>
set -uo pipefail
SYNC="$1"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

newcase() {
  R=$(mktemp -d /tmp/depdrift.XXXXXX)
  REPO="$R/repo"; CTX="$R/ctx"
  mkdir -p "$REPO/bin" "$REPO/scripts/self-healing" "$CTX/scripts"
  # SoT files in the fake repo
  printf '#!/usr/bin/env bash\necho watchdog-v2\n' > "$REPO/bin/quota-watchdog.sh"
  printf '#!/usr/bin/env bash\necho marker\n'      > "$REPO/scripts/self-healing/dispatch-marker.sh"
  chmod +x "$REPO/bin/quota-watchdog.sh" "$REPO/scripts/self-healing/dispatch-marker.sh"
  # Registry fixture
  REG="$R/registry"
  cat > "$REG" <<EOF
# test registry
scripts/quota-watchdog.sh  | bin/quota-watchdog.sh
scripts/dispatch-marker.sh | scripts/self-healing/dispatch-marker.sh
scripts/orphan.sh          | NONE
EOF
}
runsync() {  # $@ = sync args; env points registry/repo/ctx at the fixtures
  DEPLOYED_REGISTRY="$REG" DEPLOYED_REPO_ROOT="$REPO" CTX_ROOT="$CTX" \
    bash "$SYNC" "$@" --from-worktree
}

# ── C1: in-sync → check exits 0 ─────────────────────────────────────────────
echo "== [C1] deployed copies identical to SoT → check clean (exit 0) =="
newcase
cp "$REPO/bin/quota-watchdog.sh"               "$CTX/scripts/quota-watchdog.sh"
cp "$REPO/scripts/self-healing/dispatch-marker.sh" "$CTX/scripts/dispatch-marker.sh"
runsync check >/dev/null 2>&1 && ok "C1: check exits 0 when in sync" || bad "C1: check non-zero despite in-sync"
rm -rf "$R"

# ── C2: drift → check exits 1 and names the file ────────────────────────────
echo "== [C2] deployed quota-watchdog stale → check reports drift (exit 1) =="
newcase
printf '#!/usr/bin/env bash\necho watchdog-v1-STALE\n' > "$CTX/scripts/quota-watchdog.sh"
cp "$REPO/scripts/self-healing/dispatch-marker.sh" "$CTX/scripts/dispatch-marker.sh"
OUT=$(runsync check 2>&1); RC=$?
[ "$RC" -eq 1 ] && ok "C2: check exits 1 on drift" || bad "C2: check exit $RC (want 1)"
echo "$OUT" | grep -q "DRIFT.*quota-watchdog" && ok "C2: drift names quota-watchdog.sh" || bad "C2: drift did not name quota-watchdog.sh"
rm -rf "$R"

# ── C3: apply → syncs + exec bit + then clean ───────────────────────────────
echo "== [C3] apply repairs the stale copy, preserves exec bit, then check clean =="
newcase
printf 'STALE\n' > "$CTX/scripts/quota-watchdog.sh"
cp "$REPO/scripts/self-healing/dispatch-marker.sh" "$CTX/scripts/dispatch-marker.sh"
runsync apply >/dev/null 2>&1
if diff -q "$CTX/scripts/quota-watchdog.sh" "$REPO/bin/quota-watchdog.sh" >/dev/null 2>&1; then
  ok "C3: apply synced deployed copy to SoT content"
else
  bad "C3: apply did not sync content"
fi
[ -x "$CTX/scripts/quota-watchdog.sh" ] && ok "C3: synced copy is executable" || bad "C3: exec bit not set"
runsync check >/dev/null 2>&1 && ok "C3: check clean after apply" || bad "C3: still drift after apply"
rm -rf "$R"

# ── C4: missing deployed file → drift, apply creates it ─────────────────────
echo "== [C4] registered-but-missing deployed file is drift; apply creates it =="
newcase
cp "$REPO/scripts/self-healing/dispatch-marker.sh" "$CTX/scripts/dispatch-marker.sh"
# quota-watchdog.sh intentionally absent
OUT=$(runsync check 2>&1); RC=$?
[ "$RC" -eq 1 ] && ok "C4: missing file reported as drift" || bad "C4: missing file not flagged (exit $RC)"
runsync apply >/dev/null 2>&1
[ -f "$CTX/scripts/quota-watchdog.sh" ] && ok "C4: apply created the missing deployed copy" || bad "C4: apply did not create the file"
rm -rf "$R"

# ── C5: orphan (SoT == NONE) → skipped, never a hard failure ────────────────
echo "== [C5] orphan entry (NONE) is skipped, not synced, not a failure =="
newcase
cp "$REPO/bin/quota-watchdog.sh"               "$CTX/scripts/quota-watchdog.sh"
cp "$REPO/scripts/self-healing/dispatch-marker.sh" "$CTX/scripts/dispatch-marker.sh"
OUT=$(runsync check 2>&1); RC=$?
echo "$OUT" | grep -q "SKIP orphan.*orphan.sh" && ok "C5: orphan entry skipped with warning" || bad "C5: orphan not skipped"
[ ! -f "$CTX/scripts/orphan.sh" ] && ok "C5: orphan deployed file never created by sync" || bad "C5: sync created an orphan file"
[ "$RC" -eq 0 ] && ok "C5: orphan alone does not make check fail" || bad "C5: orphan made check exit $RC"
rm -rf "$R"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
