#!/bin/bash
# Regression test for the SOURCE-drift materiality classifier (deploy-drift-source-lib.sh).
# A gap between two commits is DIST-material (rebuild page) only if it touches a dist-
# affecting input (src/ + build config). A non-dist gap rebuilds identically and is INERT
# (INFO, not paged) — EXCEPT .github/workflows/**, which is OPS-material: paged anyway
# (CI/deploy surface advanced) without claiming a daemon rebuild is needed.
#
# Criteria:
#   (1) src/ change            → dist-material (paged)
#   (2) scripts-only change    → inert (the PR #66 false-page class)
#   (3) tests/docs/orgs change → inert
#   (4) build-config change    → dist-material (package.json/tsup/tsconfig affect the bundle)
#   (5) mixed src+scripts       → dist-material (src/ delta present)
#   (6) missing/garbage SHA    → non-empty sentinel (caller treats as material, fail-safe)
#   (7) .github/workflows change → ops-material (paged), NOT dist-material (no rebuild)
#   (8) scripts-only           → NOT ops-material either (stays inert)
#   (9) mixed src+workflow      → dist-material dominates (rebuild page)
#  (10) fmt_delta_summary       → count + matched-path list with "+N more" truncation
#  (11) source_drift_sig        → NEW dist file in range changes the sig (re-page; the
#                                 2026-06-26 bool-key miss — a new dist-affecting file
#                                 added while drift already=true did not re-surface to PD)
#  (12) source_drift_sig        → INERT advance (docs commit) leaves the sig UNCHANGED
#                                 (anti-spam: no per-commit re-page while a rebuild pends)
#  (13) source_drift_sig        → re-edit of an already-drifting dist file changes the sig
#                                 (content-precise via blob hash, not just the path set)
#  (14) source_drift_sig        → non-material (scripts-only) gap → empty sig
#  (15) source_drift_sig        → bad SHA → non-empty + STABLE sig (fail-safe, no fake recovery)
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
  mkdir -p "$REPO/src/daemon" "$REPO/scripts/self-healing" "$REPO/tests/shell" "$REPO/orgs/x" "$REPO/docs" "$REPO/.github/workflows"
  printf 'export const a = 1;\n' > "$REPO/src/daemon/index.ts"
  printf '{"name":"x","scripts":{"build":"tsup"}}\n' > "$REPO/package.json"
  printf 'echo hi\n' > "$REPO/scripts/self-healing/thing.sh"
  printf 'doc\n' > "$REPO/docs/readme.md"
  printf 'name: ci\non: push\n' > "$REPO/.github/workflows/ci.yml"
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

# ── C7: .github/workflows change → ops-material (page), NOT dist, NOT inert ──
echo "== [C7] .github/workflows change → ops-material full page (NOT INFO downgrade) =="
newrepo
printf 'name: ci\non: [push, pull_request]\n' > "$REPO/.github/workflows/ci.yml"; TIP=$(commit ciwf)
DIST=$(dist_material_delta "$REPO" "$BASE" "$TIP")
OPS=$(ops_material_delta "$REPO" "$BASE" "$TIP")
[ -z "$DIST" ] && ok "C7: workflow change is NOT dist-material (no daemon rebuild)" || bad "C7: workflow wrongly flagged dist-material [$DIST]"
echo "$OPS" | grep -q ".github/workflows/ci.yml" && ok "C7: workflow change IS ops-material (paged, not silenced)" || bad "C7: workflow NOT flagged ops-material [$OPS]"
rm -rf "$REPO"

# ── C8: scripts-only change → neither dist nor ops material (true INERT) ─────
echo "== [C8] scripts-only change → NOT ops-material either (stays INFO/inert) =="
newrepo
printf 'echo more\n' >> "$REPO/scripts/self-healing/thing.sh"; TIP=$(commit scriptonly)
OPS=$(ops_material_delta "$REPO" "$BASE" "$TIP")
[ -z "$OPS" ] && ok "C8: scripts-only gap is NOT ops-material (correctly stays inert)" || bad "C8: scripts-only wrongly ops-material [$OPS]"
rm -rf "$REPO"

# ── C9: mixed src + workflow → dist-material dominates (full page) ───────────
echo "== [C9] mixed src/ + workflow → dist-material (rebuild page dominates) =="
newrepo
printf 'export const d = 4;\n' >> "$REPO/src/daemon/index.ts"; printf 'name: ci\non: push\njobs: {}\n' > "$REPO/.github/workflows/ci.yml"; TIP=$(commit mixedwf)
DIST=$(dist_material_delta "$REPO" "$BASE" "$TIP")
echo "$DIST" | grep -q "src/daemon/index.ts" && ok "C9: mixed gap flagged dist-material via src/ (rebuild needed)" || bad "C9: mixed gap not dist-material [$DIST]"
rm -rf "$REPO"

# ── C10: fmt_delta_summary → count + matched-path list, with +N truncation ───
echo "== [C10] fmt_delta_summary emits count + matched-path list (one-glance triage) =="
EMPTY=$(fmt_delta_summary "")
[ "$EMPTY" = "0 file(s) []" ] && ok "C10: empty list → '0 file(s) []'" || bad "C10: empty list wrong [$EMPTY]"
ONE=$(fmt_delta_summary "src/a.ts")
echo "$ONE" | grep -q "1 file(s) \[src/a.ts\]" && ok "C10: single path listed: [$ONE]" || bad "C10: single path wrong [$ONE]"
MANY=$(printf 'f1\nf2\nf3\nf4\nf5\nf6\nf7\nf8\n')
SUM=$(fmt_delta_summary "$MANY")
echo "$SUM" | grep -q "8 file(s) \[f1, f2, f3, f4, f5, f6, +2 more\]" && ok "C10: >max truncates to +N more: [$SUM]" || bad "C10: truncation wrong [$SUM]"
echo "$SUM" | grep -q "f1" && echo "$SUM" | grep -q "+2 more" && ok "C10: summary carries actual paths (not just a count)" || bad "C10: summary missing paths [$SUM]"

# ── C11: source_drift_sig — a NEW dist file in range CHANGES the sig ─────────
# The exact 2026-06-26 escalation miss: with a bare src= bool key, a new dist-affecting
# file added while SOURCE_DRIFT was ALREADY true did not change the key → PD never saw it.
echo "== [C11] source_drift_sig: NEW dist-affecting file in range → sig changes (re-page) =="
newrepo
printf 'export const b = 2;\n' >> "$REPO/src/daemon/index.ts"; R1=$(commit srcedit)
SIG1=$(source_drift_sig "$REPO" "$BASE" "$R1")
printf 'export const c = 3;\n' > "$REPO/src/daemon/new.ts"; R2=$(commit addnewdist)
SIG2=$(source_drift_sig "$REPO" "$BASE" "$R2")
{ [ -n "$SIG1" ] && [ -n "$SIG2" ] && [ "$SIG1" != "$SIG2" ]; } \
  && ok "C11: new dist file changes the sig (${SIG1:0:12} -> ${SIG2:0:12})" \
  || bad "C11: new dist file did NOT change sig (s1=$SIG1 s2=$SIG2)"

# ── C12: an INERT advance (docs commit) in range does NOT change the sig ─────
# Anti-spam: while a planned rebuild is pending, unrelated origin/main commits must not
# re-page. A raw commit-SHA key would churn here; the path+blob set does not.
echo "== [C12] source_drift_sig: inert docs commit in range → sig UNCHANGED (no spam) =="
printf 'more docs\n' >> "$REPO/docs/readme.md"; R3=$(commit docschg)
SIG3=$(source_drift_sig "$REPO" "$BASE" "$R3")
[ "$SIG3" = "$SIG2" ] \
  && ok "C12: inert docs commit leaves sig unchanged (${SIG3:0:12})" \
  || bad "C12: inert docs commit churned the sig (s2=$SIG2 s3=$SIG3)"

# ── C13: a re-edit of an ALREADY-drifting dist file changes the sig ──────────
# Content-precise: the path set is identical but index.ts's blob hash at the target moved.
echo "== [C13] source_drift_sig: re-edit of an already-drifting dist file → sig changes =="
printf 'export const e = 5;\n' >> "$REPO/src/daemon/index.ts"; R4=$(commit srcedit2)
SIG4=$(source_drift_sig "$REPO" "$BASE" "$R4")
[ "$SIG4" != "$SIG3" ] \
  && ok "C13: re-edit of drifting file changes the sig (blob moved: ${SIG3:0:12} -> ${SIG4:0:12})" \
  || bad "C13: re-edit did NOT change sig (s3=$SIG3 s4=$SIG4)"
rm -rf "$REPO"

# ── C14: no dist/ops-material delta (scripts-only) → empty signature ─────────
echo "== [C14] source_drift_sig: non-material (scripts-only) gap → empty sig =="
newrepo
printf 'echo more\n' >> "$REPO/scripts/self-healing/thing.sh"; RS=$(commit scriptonly)
SIGS=$(source_drift_sig "$REPO" "$BASE" "$RS")
[ -z "$SIGS" ] && ok "C14: scripts-only gap → empty sig (no srcsig in key)" || bad "C14: scripts-only gap produced a sig [$SIGS]"
rm -rf "$REPO"

# ── C15: bad SHA → NON-empty, STABLE sig (fail-safe: material, no fake recovery) ─
echo "== [C15] source_drift_sig: bad SHA → non-empty + stable (fail-safe) =="
newrepo
DEAD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
B1=$(source_drift_sig "$REPO" "$BASE" "$DEAD")
B2=$(source_drift_sig "$REPO" "$BASE" "$DEAD")
{ [ -n "$B1" ] && [ "$B1" = "$B2" ]; } && ok "C15: bad SHA → non-empty stable sig (${B1:0:12})" || bad "C15: bad SHA sig empty/unstable (b1=$B1 b2=$B2)"
rm -rf "$REPO"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
