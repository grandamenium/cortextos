#!/usr/bin/env bash
# setup-upstream-pr.sh — One-time setup for the upstream auto-PR flow.
#
# Ensures:
#   1. gh CLI is installed and authenticated
#   2. A fork of grandamenium/cortextos exists under the configured owner
#      (loganbronstein by default). Created via `gh repo fork` if missing.
#   3. Remotes are wired: origin=<owner>/cortextos, upstream=grandamenium/cortextos
#
# Run once after cloning the repo:
#   bash scripts/setup-upstream-pr.sh
#
# Idempotent. Safe to re-run.

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-grandamenium/cortextos}"
FORK_OWNER="${FORK_OWNER:-loganbronstein}"
FORK_REPO="${FORK_REPO:-$FORK_OWNER/cortextos}"

log() { echo "[setup-upstream-pr] $*"; }
fail() { echo "[setup-upstream-pr] ERROR: $*" >&2; exit 1; }

# 1. gh installed
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI not installed. Install from https://cli.github.com/ and re-run."
fi

# 2. gh authed (gh auth status writes to stderr on success as well)
if ! gh auth status >/dev/null 2>&1; then
  fail "gh CLI not authenticated. Run 'gh auth login' and re-run."
fi
log "gh CLI authenticated."

# 3. Fork existence
log "Checking for fork $FORK_REPO..."
if gh repo view "$FORK_REPO" >/dev/null 2>&1; then
  log "  Fork already exists."
else
  log "  Fork not found. Creating via gh repo fork $UPSTREAM_REPO --clone=false..."
  # --remote=false: don't mutate our current git remotes (we do that ourselves below)
  gh repo fork "$UPSTREAM_REPO" --clone=false --remote=false || \
    fail "gh repo fork failed. Create $FORK_REPO manually on GitHub and re-run."
  log "  Fork created."
fi

# 4. Remote wiring
desired_origin="https://github.com/${FORK_REPO}.git"
desired_upstream="https://github.com/${UPSTREAM_REPO}.git"

ensure_remote() {
  local name="$1"
  local want="$2"
  local have
  have="$(git config --get "remote.${name}.url" 2>/dev/null || echo "")"
  if [[ -z "$have" ]]; then
    log "  Adding remote $name -> $want"
    git remote add "$name" "$want"
  elif [[ "$have" != "$want" ]]; then
    # Accept variants (https vs ssh) if they point at the same repo path
    local want_path="${want#https://github.com/}"; want_path="${want_path%.git}"
    local have_path
    case "$have" in
      git@github.com:*) have_path="${have#git@github.com:}"; have_path="${have_path%.git}" ;;
      https://github.com/*) have_path="${have#https://github.com/}"; have_path="${have_path%.git}" ;;
      *) have_path="" ;;
    esac
    if [[ "$have_path" == "$want_path" ]]; then
      log "  Remote $name already points at $have_path (keeping existing URL: $have)"
    else
      log "  Remote $name points at $have; resetting to $want"
      git remote set-url "$name" "$want"
    fi
  else
    log "  Remote $name -> $have (ok)"
  fi
}

ensure_remote origin   "$desired_origin"
ensure_remote upstream "$desired_upstream"

log ""
log "Current remotes:"
git remote -v | sed 's/^/  /'

log ""
log "Done. Next steps:"
log "  1. Run 'bash scripts/setup-hooks.sh' to install git hooks."
log "  2. Push a branch that touches src/, dashboard/, templates/, .claude/hooks/,"
log "     or scripts/ and a PR to $UPSTREAM_REPO will open automatically."
log "  3. Merge to main triggers supabase function auto-deploy (if applicable)."
