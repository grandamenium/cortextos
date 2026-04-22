#!/usr/bin/env bash
# auto-deploy-supabase.sh — Post-merge: deploy supabase functions touched by
# the merge. Closes the "merged but not shipped" gap on edge functions.
#
# Invoked by the post-merge hook (see scripts/hooks/post-merge). Runs only on
# the base branch (main). Uses ORIG_HEAD..HEAD to find files changed by the
# merge, then runs `supabase functions deploy <name> --project-ref <ref>` for
# each distinct function directory touched.
#
# Never blocks the merge. Deploy failures are logged but do not propagate.
#
# Environment overrides:
#   SUPABASE_PROJECT_REF   default: baidaaansxrfdislmgyx
#   SUPABASE_BASE_BRANCH   default: main
#   SUPABASE_FUNCTIONS_DIR default: supabase/functions
#   AUTO_DEPLOY_SKIP=1     skip everything (kill switch)
#
# macOS bash 3.2 compatible.

set -uo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-baidaaansxrfdislmgyx}"
BASE_BRANCH="${SUPABASE_BASE_BRANCH:-main}"
FUNCTIONS_DIR="${SUPABASE_FUNCTIONS_DIR:-supabase/functions}"

log() { echo "[auto-deploy-supabase] $*" >&2; }

if [[ "${AUTO_DEPLOY_SKIP:-0}" == "1" ]]; then
  log "AUTO_DEPLOY_SKIP=1 — deploy disabled."
  exit 0
fi

# 0. Only deploy from the base branch.
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ "$branch" != "$BASE_BRANCH" ]]; then
  log "Not on '$BASE_BRANCH' (on '$branch'). Skipping."
  exit 0
fi

# 1. Need supabase CLI.
if ! command -v supabase >/dev/null 2>&1; then
  log "supabase CLI not installed. Skipping."
  exit 0
fi

# 2. Post-merge gives us ORIG_HEAD (pre-merge) and HEAD (post-merge). Compare.
if ! git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
  log "ORIG_HEAD missing. Skipping."
  exit 0
fi

# 3. Collect files changed by the merge. bash 3.2: while-read only.
changed=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  changed="${changed}${f}"$'\n'
done < <(git diff --name-only ORIG_HEAD HEAD 2>/dev/null || true)

if [[ -z "$changed" ]]; then
  log "No file diff between ORIG_HEAD and HEAD. Skipping."
  exit 0
fi

# 4. Extract unique function names.
functions=""
prefix="${FUNCTIONS_DIR}/"
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    "$prefix"*)
      rest="${f#$prefix}"
      # First path segment = function name
      name="${rest%%/*}"
      # Must look like a directory entry (has a slash after it) to count as a
      # function file. Top-level files directly under $FUNCTIONS_DIR (rare —
      # shared config) are ignored.
      if [[ "$rest" == "$name" ]]; then
        continue
      fi
      # Validate name: supabase function names are alphanumeric + - / _.
      if ! echo "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'; then
        log "Skipping invalid function name: '$name'"
        continue
      fi
      # Dedupe (case with newline delimiters).
      case $'\n'"$functions"$'\n' in
        *$'\n'"$name"$'\n'*) : ;;
        *) functions="${functions}${name}"$'\n' ;;
      esac
      ;;
  esac
done <<EOF
$changed
EOF

if [[ -z "$functions" ]]; then
  log "No supabase function changes in this merge."
  exit 0
fi

# 5. Deploy each one. Skip functions whose directory was removed in the merge
#    — deploying a deleted function via the Supabase CLI is a no-op at best.
deployed=0
skipped=0
failed=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if [[ ! -d "${FUNCTIONS_DIR}/${name}" ]]; then
    log "Function '$name' no longer exists locally (deleted?). Skipping deploy."
    skipped=$((skipped + 1))
    continue
  fi
  log "Deploying '$name' to project $PROJECT_REF..."
  if supabase functions deploy "$name" --project-ref "$PROJECT_REF"; then
    deployed=$((deployed + 1))
    log "  '$name' deployed."
  else
    failed=$((failed + 1))
    log "  '$name' deploy FAILED. Check supabase logs; push/merge not blocked."
  fi
done <<EOF
$functions
EOF

log "Summary: deployed=$deployed skipped=$skipped failed=$failed"
# Never block on deploy failures.
exit 0
