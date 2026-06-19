#!/usr/bin/env bash
# cortextos-src-watch.sh — Detect stale local dist and self-heal.
#
# Compares dist/.build-sha (written by post-merge hook or postbuild script)
# against the current origin/main HEAD. If they differ, fetches + merges +
# rebuilds and then broadcasts a nudge to the rest of the fleet.
#
# Driven by the cortextos-src-watch cron (every 10 min).
# Cron fire must be recorded by the caller:
#   cortextos bus update-cron-fire cortextos-src-watch --interval 10

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[cortextos-src-watch] ERROR: not inside a git repo" >&2
  exit 1
}

cd "$REPO_ROOT"

# Fetch to learn the remote tip (quiet — no output unless something changed).
git fetch origin --quiet 2>&1 || {
  echo "[cortextos-src-watch] WARNING: git fetch failed — skipping watch" >&2
  exit 0
}

REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null || echo "")
BUILD_SHA=$(cat dist/.build-sha 2>/dev/null | tr -d '[:space:]' || echo "")

if [ -z "$REMOTE_SHA" ]; then
  echo "[cortextos-src-watch] WARNING: could not resolve origin/main" >&2
  exit 0
fi

# Up-to-date if: BUILD_SHA equals REMOTE_SHA, OR origin/main is already an
# ancestor of BUILD_SHA (local HEAD is a merge commit that includes origin/main).
if [ -n "$BUILD_SHA" ] && git merge-base --is-ancestor "$REMOTE_SHA" "$BUILD_SHA" 2>/dev/null; then
  echo "[cortextos-src-watch] dist up-to-date (origin/main ${REMOTE_SHA:0:8} ⊆ build ${BUILD_SHA:0:8})"
  exit 0
fi

LOCAL_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
echo "[cortextos-src-watch] Stale dist detected (built: ${BUILD_SHA:0:8}, origin/main: ${REMOTE_SHA:0:8}) — rebuilding..."

# Merge origin/main into current branch (no-ff to preserve history).
if ! git merge origin/main --no-edit 2>&1; then
  echo "[cortextos-src-watch] ERROR: merge conflict on $LOCAL_BRANCH — manual resolution required" >&2
  cortextos bus send-message platform-director high \
    "[cortextos-src-watch] Merge conflict on $LOCAL_BRANCH — manual git merge origin/main needed in $REPO_ROOT" \
    2>/dev/null || true
  exit 1
fi

# Rebuild dist.
if npm run build --silent 2>&1; then
  git rev-parse HEAD > dist/.build-sha 2>/dev/null || true
  NEW_SHA=$(cat dist/.build-sha | tr -d '[:space:]')
  echo "[cortextos-src-watch] Rebuild OK (SHA: ${NEW_SHA:0:8})"
else
  echo "[cortextos-src-watch] ERROR: npm run build failed after merge" >&2
  exit 1
fi

# Re-sync DEPLOYED launchd-script copies (quota-watchdog, dispatch-marker,
# project-state-writer) now that origin/main is merged in. These run self-contained
# copies under ${CTX_ROOT}/scripts/ with NO auto-sync of their own, so without this
# step a merge stays inert to them until a manual re-deploy — the root-cause class of
# the 2026-06-18 fleet false-pause (deployed quota-watchdog lagged the repo guard
# ~2wks). Best-effort: a sync failure must not abort the dist self-heal; the
# deploy-drift-probe still DETECTS and pages PD on any residual gap.
if [ -f "$REPO_ROOT/scripts/self-healing/sync-deployed-scripts.sh" ]; then
  bash "$REPO_ROOT/scripts/self-healing/sync-deployed-scripts.sh" apply 2>&1 \
    | sed 's/^/[cortextos-src-watch] /' || true
fi

# Broadcast to other alive agents so they also rebuild.
if [ -f "$REPO_ROOT/scripts/broadcast-rebuild.sh" ]; then
  bash "$REPO_ROOT/scripts/broadcast-rebuild.sh" 2>&1 | sed 's/^/[cortextos-src-watch] /' || true
fi
