#!/bin/bash
# Regression test for the SOURCE-drift ^src/ materiality filter (deploy-drift-source-lib.sh).
# A gap between two commits is "material" (page-worthy) only if it touches a dist-affecting
# input (src/ + build config); a non-dist gap rebuilds identically and must NOT page.
#
# Criteria:
#   (1) src/ change            → material (paged)
#   (2) scripts-only change    → inert (the PR #66 false-page class)
#   (3) tests/docs/orgs change → inert
#   (4) build-config change    → material (package.json/tsup/tsconfig affect the bundle)
#   (5) mixed src+scripts       → material (src/ delta present)
#   (6) missing/garbage SHA    → non-empty sentinel (caller treats as material, fail-safe)
#
# Usage: bash deploy-drift-source.test.sh <deploy-drift-source-lib.sh>
set -uo pipefail
LIB="$1"
# shellcheck source=/dev/null
source "$LIB"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

newrepo() {
  REPO=$(mktemp -d /tmp/dds.XXXXXX)
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t; git -C "$REPO" config user.name t
  mkdir -p "$REPO/src/daemon" "$REPO/scripts/self-healing" "$REPO/tests/shell" "$REPO/orgs/x" "$REPO/docs"
  printf 'export const a = 1;\n' > "$REPO/src/daemon/index.ts"
  printf '{"name":"x","scripts":{"build":"tsup"}}\n' > "$REPO/package.json"
  printf 'echo hi\n' > "$REPO/scripts/self-healing/thing.sh"
  printf 'doc\n' > "$REPO/docs/readme.md"
  git -C "$REPO" add -A >/dev/null 2>&1; git -C "$REPO" commit -qm base >/dev/null 2>&1
  BASE=$(git -C "$REPO" rev-parse HEAD)
}
commit() { git -C "$REPO" add -A >/dev/null 2>&1; git -C "$REPO" commit -qm "$1" >/dev/null 2>&1; git -C "$REPO" rev-parse HEAD; }

# ── C1: src/ change → material ──────────────────────────────────────────────
echo "== [C1] src/ change → material (paged) =="
newrepo
printf 'export const b = 2;\n' >> "$REPO/src/daemon/index.ts"; TIP=$(commit srcchg)
OUT=$(dist_material_delta "$REPO" "$BASE" "$TIP")
echo "$OUT" | grep -q "src/daemon/index.ts" && ok "C1: src/ delta flagged material" || bad "C1: src/ delta NOT flagged (got [$OUT])"
rm -rf "$REPO"

# ── C2: scripts-only change → inert ─────────────────────────────────────────
echo "== [C2] scripts-only change → inert (no page) — the PR #66 false-page class =="
newrepo
printf 'echo more\n' >> "$REPO/scripts/self-healing/thing.sh"; TIP=$(commit scriptchg)
OUT=$(dist_material_delta "$REPO" "$BASE" "$TIP")
[ -z "$OUT" ] && ok "C2: scripts-only gap is inert (empty)" || bad "C2: scripts-only flagged material [$OUT]"
rm -rf "$REPO"

# ── C3: tests/docs/orgs change → inert ──────────────────────────────────────
echo "== [C3] tests + docs + orgs change → inert =="
newrepo
printf 'test\n' > "$REPO/tests/shell/x.test.sh"; printf 'more\n' >> "$REPO/docs/readme.md"; printf 'cfg\n' > "$REPO/orgs/x/config.json"
TIP=$(commit nondist)
OUT=$(dist_material_delta "$REPO" "$BASE" "$TIP")
[ -z "$OUT" ] && ok "C3: tests/docs/orgs gap is inert" || bad "C3: non-dist flagged material [$OUT]"
rm -rf "$REPO"

# ── C4: build-config change → material ──────────────────────────────────────
echo "== [C4] package.json change → material (build config affects the bundle) =="
newrepo
printf '{"name":"x","scripts":{"build":"tsup"},"dependencies":{"foo":"1.0.0"}}\n' > "$REPO/package.json"; TIP=$(commit depbump)
OUT=$(dist_material_delta "$REPO" "$BASE" "$TIP")
echo "$OUT" | grep -q "package.json" && ok "C4: package.json delta flagged material" || bad "C4: build-config delta NOT flagged [$OUT]"
rm -rf "$REPO"

# ── C5: mixed src + scripts → material ──────────────────────────────────────
echo "== [C5] mixed src/ + scripts change → material (src/ present) =="
newrepo
printf 'export const c = 3;\n' >> "$REPO/src/daemon/index.ts"; printf 'echo x\n' >> "$REPO/scripts/self-healing/thing.sh"; TIP=$(commit mixed)
OUT=$(dist_material_delta "$REPO" "$BASE" "$TIP")
echo "$OUT" | grep -q "src/daemon/index.ts" && ok "C5: mixed gap flagged material via src/" || bad "C5: mixed gap not flagged [$OUT]"
rm -rf "$REPO"

# ── C6: missing / garbage SHA → fail-safe sentinel (material) ───────────────
echo "== [C6] missing/garbage SHA → non-empty sentinel (caller treats as material) =="
newrepo
OUT=$(dist_material_delta "$REPO" "$BASE" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
[ -n "$OUT" ] && ok "C6: bad SHA yields non-empty sentinel (fail-safe material): [$OUT]" || bad "C6: bad SHA silently inert (DANGEROUS)"
OUT2=$(dist_material_delta "$REPO" "" "")
[ -n "$OUT2" ] && ok "C6: empty SHA yields non-empty sentinel: [$OUT2]" || bad "C6: empty SHA silently inert"
rm -rf "$REPO"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
