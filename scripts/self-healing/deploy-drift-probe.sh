#!/usr/bin/env bash
# deploy-drift-probe.sh — DEVOPS detection probe for framework deploy drift.
#
# Independent DETECTION layer (defense-in-depth) for the deploy source-of-truth
# trap (SYS-DEPLOY-SOT): framework merges to main can be INERT to the live fleet
# because the live daemon runs from a specific worktree's dist that must be
# rebuilt AND the daemon process restarted to pick the code up.
#
# This probe does NOT self-heal — that is cortextos-src-watch.sh's job. The probe
# exists so that if the self-healer's cron stalls, rebuilds the wrong worktree, or
# the daemon is never restarted after a rebuild, the drift is still DETECTED and
# escalated to platform-director instead of failing silently.
#
# It resolves the LIVE daemon process from `ps` (NOT a static topology file or
# pgrep, which can miss the node process), derives the dist path it is actually
# executing, and checks three drift dimensions:
#
#   1. SOURCE drift   — origin/main has commits NOT contained in dist/.build-sha
#                       (ancestry-aware: a merge commit that includes origin/main
#                        is up-to-date). => dist needs rebuild.
#   2. RESTART drift  — the on-disk dist/daemon.js CONTENT differs from what the
#                       running daemon loaded at boot => on-disk build is ahead of
#                       the code actually running in memory. => daemon needs restart.
#                       Keyed off a per-pid content-hash fingerprint, NOT mtime: a
#                       full `tsc` rebuild bumps daemon.js mtime even when its bytes
#                       are unchanged (e.g. the rebuild's only real change was a
#                       non-daemon bin/ script), and an mtime-only check over-pages
#                       PD on those content-identical rebuilds (observed 2026-06-18,
#                       the #52 bin-only rebuild). Falls back to the mtime heuristic
#                       only when no trustworthy fingerprint exists for this pid.
#   3. SHA staleness  — dist/daemon.js mtime is NEWER than dist/.build-sha mtime
#                       => dist was rebuilt without postbuild writing the sha, so
#                        .build-sha can no longer be trusted for (1).
#
# Output: writes a machine-readable <FRAMEWORK_ROOT>/state/deploy-topology.json
# (consumable by cortextos-src-watch / improver tooling per SYS-DEPLOY-SOT improver
# suggestion #2) and, on a NEW drift state, escalates to platform-director.
#
# Driven by the deploy-drift-probe cron. Caller records the fire:
#   cortextos bus update-cron-fire deploy-drift-probe --interval 15
#
# Exit code is always 0 (a probe must never crash its cron); drift is reported via
# the JSON artifact + the PD escalation, not via exit status.

set -uo pipefail

log() { echo "[deploy-drift-probe] $*"; }

# --- 1. Resolve the LIVE daemon process + the dist it executes ----------------
# pgrep -f misses the node daemon on macOS in practice; ps is the reliable path.
DAEMON_LINE=$(ps -axww -o pid=,command= 2>/dev/null \
  | awk '/node .*\/dist\/daemon\.js/ && !/awk/ {print; exit}')

if [ -z "$DAEMON_LINE" ]; then
  log "WARNING: no live daemon process (node .../dist/daemon.js) found — nothing to probe"
  exit 0
fi

DAEMON_PID=$(echo "$DAEMON_LINE" | awk '{print $1}')
DAEMON_JS=$(echo "$DAEMON_LINE" | grep -oE '/[^ ]*/dist/daemon\.js' | head -1)
DIST_DIR=$(dirname "$DAEMON_JS")
FRAMEWORK_ROOT=$(dirname "$DIST_DIR")
BUILD_SHA_FILE="$DIST_DIR/.build-sha"

log "live daemon pid=$DAEMON_PID framework_root=$FRAMEWORK_ROOT"

# --- 2. Gather facts ----------------------------------------------------------
BUILD_SHA=$(tr -d '[:space:]' < "$BUILD_SHA_FILE" 2>/dev/null || echo "")

# origin/main tip (best-effort fetch; tolerate offline).
git -C "$FRAMEWORK_ROOT" fetch origin main --quiet 2>/dev/null || \
  log "WARNING: git fetch failed — comparing against last-known origin/main"
REMOTE_SHA=$(git -C "$FRAMEWORK_ROOT" rev-parse origin/main 2>/dev/null || echo "")

# mtimes (epoch) of the on-disk build artifacts.
DAEMON_MTIME=$(stat -f "%m" "$DAEMON_JS" 2>/dev/null || stat -c "%Y" "$DAEMON_JS" 2>/dev/null || echo "0")
SHA_MTIME=$(stat -f "%m" "$BUILD_SHA_FILE" 2>/dev/null || stat -c "%Y" "$BUILD_SHA_FILE" 2>/dev/null || echo "0")

# Running daemon's process start epoch (LC_ALL=C so weekday/month are English).
LSTART=$(LC_ALL=C ps -o lstart= -p "$DAEMON_PID" 2>/dev/null | sed 's/^ *//;s/ *$//')
PROC_START_EPOCH=$(LC_ALL=C date -j -f "%a %b %e %T %Y" "$LSTART" +%s 2>/dev/null \
  || LC_ALL=C date -d "$LSTART" +%s 2>/dev/null || echo "0")

# Content hash of the on-disk daemon.js (the artifact a restart would load). This is
# what restart_drift compares against the running daemon's boot-time fingerprint, so
# byte-identical rebuilds don't read as "needs restart". shasum on macOS, sha256sum on Linux.
DAEMON_HASH=$(shasum -a 256 "$DAEMON_JS" 2>/dev/null | awk '{print $1}' \
  || sha256sum "$DAEMON_JS" 2>/dev/null | awk '{print $1}' || echo "")

# --- 3. Evaluate the three drift dimensions -----------------------------------
SOURCE_DRIFT="false"; RESTART_DRIFT="false"; SHA_STALE="false"
REASONS=()

if [ -n "$REMOTE_SHA" ] && [ -n "$BUILD_SHA" ]; then
  if ! git -C "$FRAMEWORK_ROOT" merge-base --is-ancestor "$REMOTE_SHA" "$BUILD_SHA" 2>/dev/null; then
    SOURCE_DRIFT="true"
    REASONS+=("SOURCE: origin/main ${REMOTE_SHA:0:8} not contained in build ${BUILD_SHA:0:8} — dist needs rebuild")
  fi
elif [ -z "$BUILD_SHA" ]; then
  SHA_STALE="true"
  REASONS+=("SHA: $BUILD_SHA_FILE missing/empty — cannot verify source freshness")
fi

# RESTART drift via per-pid content fingerprint (see header note). The fingerprint
# file stores "<pid>:<daemon.js hash>" = the content this running daemon loaded at
# boot. When on-disk daemon.js is newer than proc start we decide by CONTENT, not
# mtime; we (re)baseline whenever on-disk == loaded so byte-identical rebuilds are
# silent. NEW_FP, if set, is persisted after the state dir is ensured (section 4).
FINGERPRINT_FILE="$FRAMEWORK_ROOT/state/.deploy-daemon-fingerprint"
FP_PID=""; FP_HASH=""
if [ -f "$FINGERPRINT_FILE" ]; then
  FP_PID=$(awk -F: 'NR==1{print $1}' "$FINGERPRINT_FILE" 2>/dev/null)
  FP_HASH=$(awk -F: 'NR==1{print $2}' "$FINGERPRINT_FILE" 2>/dev/null)
fi
NEW_FP=""

if [ "$PROC_START_EPOCH" -gt 0 ] && [ "$DAEMON_MTIME" -gt "$PROC_START_EPOCH" ]; then
  # On-disk daemon.js was written after this pid booted. Decide by content.
  if [ "$FP_PID" = "$DAEMON_PID" ] && [ -n "$FP_HASH" ] && [ -n "$DAEMON_HASH" ]; then
    if [ "$DAEMON_HASH" != "$FP_HASH" ]; then
      RESTART_DRIFT="true"
      REASONS+=("RESTART: dist/daemon.js content changed since the running daemon (pid $DAEMON_PID) loaded it — daemon needs restart")
    fi
    # else: byte-identical rebuild — NOT a restart condition (mtime-only false-positive suppressed).
  else
    # No trustworthy content baseline for this pid (first sighting already post-rebuild).
    # Conservative: fall back to the mtime heuristic so a genuine drift is never MISSED.
    RESTART_DRIFT="true"
    REASONS+=("RESTART: dist/daemon.js rebuilt after the daemon started (no content baseline for pid $DAEMON_PID; mtime-based) — daemon may need restart")
  fi
elif [ "$PROC_START_EPOCH" -gt 0 ] && [ -n "$DAEMON_HASH" ]; then
  # On-disk daemon.js is NOT newer than proc start => it IS what the daemon loaded.
  # (Re)baseline this pid's fingerprint to the current content hash.
  NEW_FP="${DAEMON_PID}:${DAEMON_HASH}"
fi

if [ "$SHA_MTIME" -gt 0 ] && [ "$DAEMON_MTIME" -gt "$SHA_MTIME" ]; then
  SHA_STALE="true"
  REASONS+=("SHA: daemon.js newer than .build-sha — sha not rewritten by postbuild, source check unreliable")
fi

DRIFT="false"
if [ "$SOURCE_DRIFT" = "true" ] || [ "$RESTART_DRIFT" = "true" ] || [ "$SHA_STALE" = "true" ]; then
  DRIFT="true"
fi

# --- 4. Write the machine-readable topology/status artifact -------------------
STATE_DIR="$FRAMEWORK_ROOT/state"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Persist the running daemon's content fingerprint (baselined above when on-disk
# daemon.js == what this pid loaded). Lets the next run decide restart_drift by
# content rather than mtime. Best-effort — never block the probe.
if [ -n "$NEW_FP" ]; then echo "$NEW_FP" > "$FINGERPRINT_FILE" 2>/dev/null || true; fi

TOPOLOGY_FILE="$STATE_DIR/deploy-topology.json"
REASONS_JSON=$(printf '%s\n' "${REASONS[@]:-}" | python3 -c "import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))" 2>/dev/null || echo "[]")

cat > "$TOPOLOGY_FILE" <<EOF
{
  "framework_root": "$FRAMEWORK_ROOT",
  "daemon_pid": $DAEMON_PID,
  "daemon_js": "$DAEMON_JS",
  "build_sha": "$BUILD_SHA",
  "origin_main_sha": "$REMOTE_SHA",
  "daemon_js_hash": "$DAEMON_HASH",
  "daemon_loaded_hash": "${FP_HASH:-}",
  "daemon_js_mtime": $DAEMON_MTIME,
  "build_sha_mtime": $SHA_MTIME,
  "proc_start_epoch": $PROC_START_EPOCH,
  "drift": $DRIFT,
  "source_drift": $SOURCE_DRIFT,
  "restart_drift": $RESTART_DRIFT,
  "sha_stale": $SHA_STALE,
  "reasons": $REASONS_JSON
}
EOF
log "wrote $TOPOLOGY_FILE (drift=$DRIFT)"

# --- 5. Escalate on MATERIAL drift change (dedup — no spam) -------------------
# Per platform-director directive (OPS-DAEMON-RESTART, 2026-06-18): a restart_drift
# that PD has already acknowledged + ticketed must NOT re-page every 15 min. Re-page
# ONLY when the situation MATERIALLY changes — source_drift flips true, sha_stale
# flips true, or a NEW daemon pid appears. The dedup key therefore deliberately
# EXCLUDES restart_drift, build_sha and mtime: a same-pid restart_drift (incl. repeated
# improver rebuilds of the daemon while it awaits its planned restart) keeps the same
# key and is suppressed after the first page. A fresh pid (the restart landed, or a
# crash-respawn) changes the key, which both clears the old condition and surfaces any
# new one. The topology artifact is still rewritten every run regardless of paging.
MARKER="$STATE_DIR/.deploy-drift-last"
DRIFT_KEY="src=${SOURCE_DRIFT};sha=${SHA_STALE};pid=${DAEMON_PID}"
LAST_KEY=$(cat "$MARKER" 2>/dev/null || echo "")

if [ "$DRIFT" = "true" ]; then
  for r in "${REASONS[@]}"; do log "DRIFT: $r"; done
  if [ "$DRIFT_KEY" != "$LAST_KEY" ]; then
    SUMMARY=$(printf '%s; ' "${REASONS[@]}")
    cortextos bus send-message platform-director high \
      "[deploy-drift-probe] Live daemon (pid $DAEMON_PID) deploy drift in $FRAMEWORK_ROOT. ${SUMMARY}Detail: $TOPOLOGY_FILE" \
      2>/dev/null && log "escalated to platform-director" || log "WARNING: PD escalation failed"
    cortextos bus log-event action deploy_drift_detected warn \
      --meta "{\"pid\":$DAEMON_PID,\"source_drift\":$SOURCE_DRIFT,\"restart_drift\":$RESTART_DRIFT,\"sha_stale\":$SHA_STALE}" 2>/dev/null || true
    echo "$DRIFT_KEY" > "$MARKER"
  else
    log "drift unchanged since last fire — escalation suppressed (idempotent)"
  fi
else
  log "no drift: origin/main ⊆ build, daemon running current on-disk build"
  [ -f "$MARKER" ] && rm -f "$MARKER" && log "cleared prior drift marker (recovered)"
fi

exit 0
