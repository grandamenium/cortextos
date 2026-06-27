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

# trees_equal <sha_a> <sha_b> — true if both resolve to commits with byte-identical
# file TREES (git rev-parse <sha>^{tree}). Used alongside merge-base --is-ancestor to
# suppress a recurring false-positive class: a build-sha whose commit topology differs
# from origin (squash-merge, feature-branch merge commits) but whose tree is identical —
# rebuilding/restarting on those yields identical dist for zero functional gain
# (PD-confirmed 2026-06-27, daemon-worktree 372f96ca vs squash dab8372d). Fails closed:
# an unresolvable sha returns non-zero, so the caller falls back to the is-ancestor gate.
trees_equal() {
  local ta tb
  ta=$(git rev-parse --verify --quiet "$1^{tree}" 2>/dev/null) || return 1
  tb=$(git rev-parse --verify --quiet "$2^{tree}" 2>/dev/null) || return 1
  [ -n "$ta" ] && [ "$ta" = "$tb" ]
}

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

# Up-to-date if: origin/main is already an ancestor of BUILD_SHA (local HEAD is a merge
# commit that includes origin/main), OR the two commits have byte-identical trees
# (topology-only difference, e.g. squash-merge — no rebuild would change dist).
if [ -n "$BUILD_SHA" ] && { git merge-base --is-ancestor "$REMOTE_SHA" "$BUILD_SHA" 2>/dev/null || trees_equal "$BUILD_SHA" "$REMOTE_SHA"; }; then
  echo "[cortextos-src-watch] dist up-to-date (origin/main ${REMOTE_SHA:0:8} ⊆ build ${BUILD_SHA:0:8})"
  # Secondary check: if the running daemon executes from a DIFFERENT worktree dist,
  # verify that dist is also current. Without this, a current CLI binary masks a
  # daemon worktree that was never rebuilt (root-cause of 2026-06-21 SYS-DAEMON-DIST-LAG).
  DAEMON_JS=$(ps -axww -o command= 2>/dev/null \
    | awk '/node .*\/dist\/daemon\.js/ && !/awk/ {
        for(i=1;i<=NF;i++) if($i ~ /\/dist\/daemon\.js$/) {print $i; exit}
      }') || true  # awk early-exit causes SIGPIPE on ps; suppress pipefail
  if [ -n "$DAEMON_JS" ] && [ "$DAEMON_JS" != "$REPO_ROOT/dist/daemon.js" ]; then
    DAEMON_DIST_DIR=$(dirname "$DAEMON_JS")
    DAEMON_BUILD_SHA=$(cat "$DAEMON_DIST_DIR/.build-sha" 2>/dev/null | tr -d '[:space:]' || echo "")
    if [ -z "$DAEMON_BUILD_SHA" ]; then
      echo "[cortextos-src-watch] WARNING: daemon worktree dist no .build-sha at $DAEMON_DIST_DIR — cannot verify" >&2
    elif git merge-base --is-ancestor "$REMOTE_SHA" "$DAEMON_BUILD_SHA" 2>/dev/null || trees_equal "$DAEMON_BUILD_SHA" "$REMOTE_SHA"; then
      echo "[cortextos-src-watch] daemon worktree dist up-to-date (${DAEMON_BUILD_SHA:0:8} ⊇ ${REMOTE_SHA:0:8} at $DAEMON_DIST_DIR)"
      # Lag has cleared — drop the dedup signature AND any task-mute marker so a
      # future (unrelated) lag re-pages and is never silently swallowed by a
      # marker that outlived the drift it was deferring.
      _LAG_STATE_DIR="${CTX_ROOT:-$HOME/.cortextos/default}/state"
      rm -f "$_LAG_STATE_DIR/src-watch-daemon-lag.sig" "$_LAG_STATE_DIR/src-watch-daemon-lag.mute" 2>/dev/null || true
    else
      echo "[cortextos-src-watch] WARNING: daemon worktree dist LAG — daemon@${DAEMON_BUILD_SHA:0:8} behind origin/main ${REMOTE_SHA:0:8} ($DAEMON_DIST_DIR)" >&2
      LAG_STATE_DIR="${CTX_ROOT:-$HOME/.cortextos/default}/state"

      # --- Task-aware mute (outer layer) ---------------------------------------
      # A deferred-and-owned lag (an open platform-director task tracking THIS
      # worktree rebuild) re-pages with zero new signal on every main-advance,
      # because each advance is a genuinely-new SHA signature. If a mute marker
      # names an OPEN task, suppress the page until that task resolves. The
      # marker holds the task id (first line of the mute file); the rebuild owner
      # writes it when they accept the deferral (PD request 2026-06-25).
      # FAIL-OPEN: any lookup failure / ambiguity falls through to paging — a
      # mute must never silently hide a real lag. Self-clearing: a marker whose
      # task is completed/cancelled is deleted and paging resumes.
      MUTE_FILE="$LAG_STATE_DIR/src-watch-daemon-lag.mute"
      LAG_MUTED=""
      if [ -f "$MUTE_FILE" ]; then
        MUTE_TASK=$(head -n1 "$MUTE_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$MUTE_TASK" ]; then
          MUTE_STATUS=$(cortextos bus list-tasks --format json 2>/dev/null \
            | MUTE_TASK="$MUTE_TASK" python3 -c 'import json,os,sys
try: tasks=json.load(sys.stdin)
except Exception: sys.exit(0)
tid=os.environ["MUTE_TASK"]
for t in tasks:
  if t.get("id")==tid:
    print(t.get("status","")); break' 2>/dev/null)
          if [ "$MUTE_STATUS" = "pending" ] || [ "$MUTE_STATUS" = "in_progress" ]; then
            LAG_MUTED="$MUTE_TASK"
          elif [ -n "$MUTE_STATUS" ]; then
            # Task resolved (completed/cancelled) — drop the stale marker, resume paging.
            rm -f "$MUTE_FILE" 2>/dev/null || true
          fi
          # Empty MUTE_STATUS (lookup failed or task not found): fail-open — do
          # NOT suppress; leave the marker in place for the owner to manage.
        fi
      fi

      if [ -n "$LAG_MUTED" ]; then
        echo "[cortextos-src-watch] daemon worktree dist lag — page MUTED by open task $LAG_MUTED (known/owned, deferred rebuild)"
      else
        # --- SHA-level dedup (inner layer) -------------------------------------
        # Only page when the drift signature (daemon-built-sha : origin-main-sha)
        # changes. An unchanged signature on every 10-min fire is the SAME
        # unresolved lag — re-paging it is noise (PD correction 2026-06-25;
        # devops-monitor probe dedups likewise). The signature changes (and
        # re-pages) when origin/main advances or the worktree is rebuilt; the
        # up-to-date branch above clears it once the lag resolves.
        LAG_SIG="${DAEMON_BUILD_SHA}:${REMOTE_SHA}"
        LAG_SIG_FILE="$LAG_STATE_DIR/src-watch-daemon-lag.sig"
        LAST_LAG_SIG=$(cat "$LAG_SIG_FILE" 2>/dev/null || echo "")
        if [ "$LAG_SIG" != "$LAST_LAG_SIG" ]; then
          cortextos bus send-message platform-director high \
            "[cortextos-src-watch] Daemon worktree dist lag: $DAEMON_DIST_DIR built@${DAEMON_BUILD_SHA:0:8} but origin/main@${REMOTE_SHA:0:8} — worktree rebuild+restart needed (mute: write task id to $MUTE_FILE to defer)" \
            2>/dev/null || true
          mkdir -p "$LAG_STATE_DIR" 2>/dev/null || true
          printf '%s' "$LAG_SIG" > "$LAG_SIG_FILE" 2>/dev/null || true
        else
          echo "[cortextos-src-watch] daemon worktree dist lag UNCHANGED (${LAG_SIG}) — page deduped"
        fi
      fi
    fi
  fi
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
