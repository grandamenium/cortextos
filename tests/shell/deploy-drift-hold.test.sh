#!/bin/bash
# Regression test for SYS-DEPLOY-SOT dirty-tree class: deploy-drift-hold-lib.sh
# classifies a RESTART drift built from a DIRTY working tree as a do-not-restart HOLD.
#
# Root incident 2026-06-19: improver rebuilt dist from an uncommitted symbol
# (detectModelBillingConfigError in src/daemon/agent-process.ts); the committed-SHA
# diff showed EMPTY -> mis-triaged "inert", but a restart would have loaded unreviewed
# daemon code. The lib must trace the uncommitted symbol INTO the built dist.
#
# Criteria:
#   (1) clean tree                       → no traced symbols (no HOLD)
#   (2) dirty daemon src, symbol in dist → traces the symbol (HOLD)
#   (3) dirty daemon src, symbol NOT in dist (committed dist) → no trace (no HOLD)
#   (4) dirty file OUTSIDE src/daemon/   → ignored (no trace)
#   (5) short/common identifiers         → not matched (no false HOLD)
#   (6) list_dirty_daemon_files          → lists only src/daemon/ M/A paths
#
# Usage: bash deploy-drift-hold.test.sh <deploy-drift-hold-lib.sh>
set -uo pipefail
LIB="$1"
# shellcheck source=/dev/null
source "$LIB"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

newrepo() {  # makes a git repo with committed src/daemon + dist, returns in $REPO
  REPO=$(mktemp -d /tmp/ddh.XXXXXX)
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t; git -C "$REPO" config user.name t
  mkdir -p "$REPO/src/daemon" "$REPO/dist"
  printf 'export function existingThing() { return 1; }\n' > "$REPO/src/daemon/agent-process.ts"
  printf '// bundled daemon\nfunction existingThing(){return 1}\n' > "$REPO/dist/daemon.js"
  git -C "$REPO" add -A >/dev/null 2>&1
  git -C "$REPO" commit -qm init >/dev/null 2>&1
  DJS="$REPO/dist/daemon.js"
}

# ── C1: clean tree → no traced symbols ──────────────────────────────────────
echo "== [C1] clean working tree → no HOLD =="
newrepo
OUT=$(trace_uncommitted_daemon_symbols "$REPO" "$DJS")
[ -z "$OUT" ] && ok "C1: clean tree traces nothing" || bad "C1: traced [$OUT] on a clean tree"
rm -rf "$REPO"

# ── C2: dirty daemon src + symbol present in dist → HOLD ────────────────────
echo "== [C2] uncommitted symbol present in the built dist → traced (HOLD) =="
newrepo
# uncommitted new symbol in daemon src
printf 'export function detectModelBillingConfigError() { return true; }\n' >> "$REPO/src/daemon/agent-process.ts"
# simulate a dirty-tree rebuild: the dist now carries that uncommitted symbol
printf 'function detectModelBillingConfigError(){return true}\n' >> "$DJS"
OUT=$(trace_uncommitted_daemon_symbols "$REPO" "$DJS")
echo "$OUT" | grep -q "detectModelBillingConfigError" \
  && ok "C2: traced the uncommitted symbol into the dist (HOLD)" \
  || bad "C2: did not trace the uncommitted symbol (got [$OUT])"
rm -rf "$REPO"

# ── C3: dirty daemon src but dist does NOT carry it → no HOLD ────────────────
echo "== [C3] uncommitted symbol NOT in dist (committed build) → no HOLD =="
newrepo
printf 'export function detectModelBillingConfigError() { return true; }\n' >> "$REPO/src/daemon/agent-process.ts"
# dist left as the committed build (does NOT contain the new symbol)
OUT=$(trace_uncommitted_daemon_symbols "$REPO" "$DJS")
[ -z "$OUT" ] && ok "C3: no trace when dist does not carry the uncommitted symbol" \
  || bad "C3: false HOLD — traced [$OUT] though dist is the committed build"
rm -rf "$REPO"

# ── C4: dirty file OUTSIDE src/daemon/ → ignored ────────────────────────────
echo "== [C4] dirty file outside src/daemon/ → ignored =="
newrepo
mkdir -p "$REPO/src/cli"
printf 'export function someCliOnlyHelper() { return 2; }\n' > "$REPO/src/cli/thing.ts"
printf 'function someCliOnlyHelper(){return 2}\n' >> "$DJS"
git -C "$REPO" add src/cli >/dev/null 2>&1  # tracked, but not under src/daemon/
OUT=$(trace_uncommitted_daemon_symbols "$REPO" "$DJS")
[ -z "$OUT" ] && ok "C4: non-daemon dirty file ignored" || bad "C4: traced non-daemon change [$OUT]"
rm -rf "$REPO"

# ── C5: short identifiers not matched (no false HOLD) ───────────────────────
echo "== [C5] short identifiers (<8 chars) not matched =="
newrepo
printf 'export const foo = 1;\nfunction barbaz() {}\n' >> "$REPO/src/daemon/agent-process.ts"
printf 'const foo=1;function barbaz(){}\n' >> "$DJS"  # both short, both in dist
OUT=$(trace_uncommitted_daemon_symbols "$REPO" "$DJS")
[ -z "$OUT" ] && ok "C5: short identifiers ignored (no false HOLD)" || bad "C5: matched short id [$OUT]"
rm -rf "$REPO"

# ── C6: list_dirty_daemon_files ─────────────────────────────────────────────
echo "== [C6] list_dirty_daemon_files lists only src/daemon/ M/A paths =="
newrepo
printf 'x\n' >> "$REPO/src/daemon/agent-process.ts"   # dirty daemon file
mkdir -p "$REPO/src/cli"; printf 'y\n' > "$REPO/src/cli/other.ts"; git -C "$REPO" add src/cli >/dev/null 2>&1
LST=$(list_dirty_daemon_files "$REPO")
echo "$LST" | grep -q "src/daemon/agent-process.ts" && ok "C6: lists the dirty daemon file" || bad "C6: missed the dirty daemon file"
echo "$LST" | grep -q "src/cli" && bad "C6: leaked a non-daemon path" || ok "C6: excludes non-daemon paths"
rm -rf "$REPO"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
