#!/usr/bin/env bash
# setup-hooks.sh — Install cortextOS git hooks into the local repo
#
# Run once after cloning:
#   bash scripts/setup-hooks.sh
#
# Installs a pre-push hook that runs npm run build && npm test before
# any push. If either fails, the push is aborted and you fix it locally
# rather than failing on CI.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside a git repository." >&2
  exit 1
}

HOOKS_PATH="$(git rev-parse --git-path hooks 2>/dev/null)" || {
  echo "Error: could not resolve this repository's hooks directory." >&2
  exit 1
}
case "$HOOKS_PATH" in
  /*) HOOKS_DIR="$HOOKS_PATH" ;;
  *) HOOKS_DIR="$REPO_ROOT/$HOOKS_PATH" ;;
esac
mkdir -p "$HOOKS_DIR"

HOOK_STATUS="unavailable"

report_existing_hook() {
  local src="$1"
  local dest="$2"

  if cmp -s "$src" "$dest"; then
    chmod +x "$dest"
    HOOK_STATUS="ready"
    echo "  Already installed and executable: $dest"
  else
    HOOK_STATUS="preserved-existing"
    echo "  Skipped: $dest already exists (leaving your hook in place)"
  fi
}

install_hook() {
  local name="$1"
  local src="$REPO_ROOT/scripts/hooks/$name"
  local dest="$HOOKS_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "Warning: hook source not found: $src (skipping)" >&2
    HOOK_STATUS="source-missing"
    return
  fi

  # Non-clobbering: never overwrite an existing hook the user/operator installed
  # (e.g. a local leak-guard pre-push). Only install when there is no hook, or
  # when the existing hook is byte-identical to ours (already installed). The
  # -L catches a broken symlink too, which -e alone would miss (and then clobber).
  if [[ -e "$dest" || -L "$dest" ]]; then
    report_existing_hook "$src" "$dest"
    return
  fi

  # Build the hook beside its destination, then hard-link it into place. The
  # link is atomic and fails rather than overwriting a hook created after the
  # existence check above.
  local tmp
  tmp="$(mktemp "$HOOKS_DIR/.${name}.tmp.XXXXXX")"
  if ! cp "$src" "$tmp" || ! chmod +x "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ln "$tmp" "$dest" 2>/dev/null; then
    rm -f "$tmp"
    HOOK_STATUS="installed"
    echo "  Installed: $dest"
  else
    rm -f "$tmp"
    if [[ -e "$dest" || -L "$dest" ]]; then
      report_existing_hook "$src" "$dest"
    elif (set -o noclobber; cat "$src" > "$dest") 2>/dev/null; then
      chmod +x "$dest"
      HOOK_STATUS="installed"
      echo "  Installed without hard links: $dest"
    elif [[ -e "$dest" || -L "$dest" ]]; then
      report_existing_hook "$src" "$dest"
    else
      echo "Error: could not install hook at $dest" >&2
      return 1
    fi
  fi
}

echo "Installing cortextOS git hooks..."
install_hook pre-push
echo "HOOK_STATUS=$HOOK_STATUS"
