#!/usr/bin/env bash
# sync-deployed-scripts.sh — keep DEPLOYED launchd-script copies in lock-step with
# their repo source-of-truth, closing the deployed-copy no-sync gap (SYS-DEPLOY-SOT,
# deployed-copy class). Companion to deploy-drift-probe.sh's DETECTION dimension:
# the probe alerts on drift, THIS script remediates it (and is safe to wire into a
# post-merge hook or a boot step so the deployed copies cannot silently re-staleify).
#
# Reads the shared registry scripts/self-healing/deployed-scripts.registry.
#
# Usage:
#   sync-deployed-scripts.sh [check|apply] [--from-worktree]
#
#   check          (default) report drift only; exit 1 if any entry drifts, 0 if clean.
#   apply          copy each SoT over its deployed path when they differ (atomic write,
#                  preserves the exec bit). Exit 0 on success.
#   --from-worktree compare/copy from the LOCAL checked-out file instead of
#                  `git show origin/main:<sot>`. Use to deploy a not-yet-merged local
#                  change for testing; default tracks origin/main (the merged truth).
#
# ORPHAN entries (SoT == NONE) are skipped with a warning — they have no recoverable
# source, so sync cannot help; fix by adopting the deployed copy into the repo.
#
# Exit codes: check -> 0 clean / 1 drift detected; apply -> 0 ok / 2 a copy failed.

set -uo pipefail

MODE="check"
FROM_WORKTREE=0
for arg in "$@"; do
  case "$arg" in
    check|apply) MODE="$arg" ;;
    --from-worktree) FROM_WORKTREE=1 ;;
    *) echo "[sync-deployed-scripts] unknown arg: $arg" >&2; exit 64 ;;
  esac
done

log() { echo "[sync-deployed-scripts] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REGISTRY / REPO_ROOT / CTX_ROOT are env-overridable so the test harness can point
# them at fixtures (DEPLOYED_REGISTRY, DEPLOYED_REPO_ROOT, CTX_ROOT).
REGISTRY="${DEPLOYED_REGISTRY:-$SCRIPT_DIR/deployed-scripts.registry}"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"

[ -f "$REGISTRY" ] || { log "ERROR: registry not found at $REGISTRY"; exit 64; }

REPO_ROOT="${DEPLOYED_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")}"
[ -n "$REPO_ROOT" ] || { log "ERROR: not inside a git repo (cannot resolve SoT)"; exit 64; }

# Best-effort fetch so origin/main is current (tolerate offline / --from-worktree).
if [ "$FROM_WORKTREE" -eq 0 ]; then
  git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null || \
    log "WARNING: git fetch failed — comparing against last-known origin/main"
fi

hash_of() { shasum -a 256 2>/dev/null | awk '{print $1}'; }

DRIFT=0
APPLY_FAIL=0

# Read the registry: strip comments/blank lines, split on the pipe.
while IFS='|' read -r dep sot; do
  dep="$(echo "$dep" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
  sot="$(echo "${sot:-}" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$dep" ] && continue

  DEP_PATH="$CTX_ROOT/$dep"

  if [ "$sot" = "NONE" ] || [ -z "$sot" ]; then
    log "SKIP orphan (no repo SoT): $dep — adopt the deployed copy into the repo to make it recoverable"
    continue
  fi

  # Resolve the SoT content (origin/main by default; local worktree with --from-worktree).
  if [ "$FROM_WORKTREE" -eq 1 ]; then
    [ -f "$REPO_ROOT/$sot" ] || { log "WARNING: worktree SoT missing: $sot — skipping"; continue; }
    SRC_HASH="$(hash_of < "$REPO_ROOT/$sot")"
  else
    if ! git -C "$REPO_ROOT" cat-file -e "origin/main:$sot" 2>/dev/null; then
      log "WARNING: origin/main:$sot does not exist — skipping"; continue
    fi
    SRC_HASH="$(git -C "$REPO_ROOT" show "origin/main:$sot" | hash_of)"
  fi

  DEP_HASH="$(hash_of < "$DEP_PATH" 2>/dev/null || echo "")"

  if [ "$DEP_HASH" = "$SRC_HASH" ]; then
    log "ok: $dep == ${sot} (${SRC_HASH:0:12})"
    continue
  fi

  DRIFT=1
  SRC_REF=$( [ "$FROM_WORKTREE" -eq 1 ] && echo worktree || echo origin/main )
  DEP_SHOW="${DEP_HASH:0:12}"; [ -z "$DEP_HASH" ] && DEP_SHOW="missing"
  log "DRIFT: $dep ($DEP_SHOW) != ${sot}@${SRC_REF} (${SRC_HASH:0:12})"

  if [ "$MODE" = "apply" ]; then
    mkdir -p "$(dirname "$DEP_PATH")" 2>/dev/null || true
    TMP="$DEP_PATH.sync.$$"
    if [ "$FROM_WORKTREE" -eq 1 ]; then
      cp "$REPO_ROOT/$sot" "$TMP" 2>/dev/null
    else
      git -C "$REPO_ROOT" show "origin/main:$sot" > "$TMP" 2>/dev/null
    fi
    if [ -s "$TMP" ]; then
      chmod +x "$TMP" 2>/dev/null || true
      if mv -f "$TMP" "$DEP_PATH" 2>/dev/null; then
        log "  -> synced $dep"
      else
        rm -f "$TMP" 2>/dev/null; APPLY_FAIL=1
        log "  -> FAILED to move into place: $DEP_PATH"
      fi
    else
      rm -f "$TMP" 2>/dev/null; APPLY_FAIL=1
      log "  -> FAILED: empty source content for $sot"
    fi
  fi
done < "$REGISTRY"

if [ "$MODE" = "apply" ]; then
  [ "$APPLY_FAIL" -eq 0 ] && { log "apply complete"; exit 0; } || { log "apply finished WITH FAILURES"; exit 2; }
fi

# check mode
if [ "$DRIFT" -eq 1 ]; then
  log "RESULT: drift detected (run with 'apply' to remediate)"; exit 1
fi
log "RESULT: all deployed copies in sync"; exit 0
