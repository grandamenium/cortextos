#!/usr/bin/env bash
# auto-pr-upstream.sh — Detect framework changes and auto-open a PR to upstream.
#
# Invoked by the pre-push hook (see scripts/hooks/pre-push) after build/test
# pass. Decides whether the current branch has framework changes worth
# upstreaming and, if so, opens a PR from <fork-owner>:<branch> into
# grandamenium/cortextos:main. Idempotent: skips when a PR already exists.
#
# Never blocks the push. All failure paths exit 0 and log a warning; the push
# continues regardless of gh / network / auth state.
#
# Environment overrides (used by tests and advanced setups):
#   UPSTREAM_REPO     default: grandamenium/cortextos
#   FORK_OWNER        default: loganbronstein
#   BASE_BRANCH       default: main
#   CORE_PATHS_REGEX  default: ^(src/|dashboard/|templates/|\.claude/hooks/|scripts/)
#   AUTO_PR_BRANCH    override branch detection (useful from pre-push hook)
#   AUTO_PR_TITLE     override PR title
#   AUTO_PR_BODY      override PR body
#
# macOS bash 3.2 compatible. No mapfile / readarray.

set -uo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-grandamenium/cortextos}"
FORK_OWNER="${FORK_OWNER:-loganbronstein}"
BASE_BRANCH="${BASE_BRANCH:-main}"
CORE_PATHS_REGEX="${CORE_PATHS_REGEX:-^(src/|dashboard/|templates/|\\.claude/hooks/|scripts/)}"

log() { echo "[auto-pr-upstream] $*" >&2; }

# 0. Resolve branch. Prefer explicit env (from pre-push hook) so background
#    invocations after checkout don't see a stale HEAD.
branch="${AUTO_PR_BRANCH:-}"
if [[ -z "$branch" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
fi
if [[ -z "$branch" ]] || [[ "$branch" == "HEAD" ]]; then
  log "Could not determine branch name (detached HEAD?). Skipping."
  exit 0
fi

# Don't auto-PR from the base branch itself.
if [[ "$branch" == "$BASE_BRANCH" ]] || [[ "$branch" == "master" ]]; then
  log "On base branch '$branch'. Skipping."
  exit 0
fi

# Defensive: reject branch names containing whitespace or shell metacharacters
# that could wedge `gh pr create --head owner:branch`. Git itself forbids
# spaces in refs, but the env override AUTO_PR_BRANCH can still smuggle them.
case "$branch" in
  *[[:space:]]*|*'$'*|*'`'*|*'"'*|*"'"*|*'\'*|*'&'*|*'|'*|*';'*|*'<'*|*'>'*|*'('*|*')'*|*'{'*|*'}'*)
    log "Refusing to open PR: branch name '$branch' contains unsafe characters."
    exit 0
    ;;
esac
# Stricter allowlist: git branch conventions.
if ! echo "$branch" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'; then
  log "Refusing to open PR: branch name '$branch' does not match safe pattern."
  exit 0
fi

# 1. gh CLI
if ! command -v gh >/dev/null 2>&1; then
  log "gh CLI not installed. Skipping upstream PR."
  exit 0
fi
if ! gh auth status >/dev/null 2>&1; then
  log "gh CLI not authenticated. Skipping upstream PR."
  exit 0
fi

# 2. upstream remote must exist
if ! git config --get remote.upstream.url >/dev/null 2>&1; then
  log "No 'upstream' remote configured. Run 'bash scripts/setup-upstream-pr.sh' first."
  exit 0
fi

# 3. Try to refresh upstream/<base>. Non-fatal: if we can't reach the network
#    we'll use whatever is cached locally.
if ! git fetch upstream "$BASE_BRANCH" --quiet 2>/dev/null; then
  log "Warning: could not fetch upstream/$BASE_BRANCH (offline?). Using local ref."
fi

# Require upstream/<base> to exist locally after fetch attempt.
if ! git rev-parse --verify "upstream/$BASE_BRANCH" >/dev/null 2>&1; then
  log "No upstream/$BASE_BRANCH ref available locally. Skipping."
  exit 0
fi

# 4. Behind-upstream warning (non-blocking). This flags branches that never
#    rebased onto the current upstream main.
if ! git merge-base --is-ancestor "upstream/$BASE_BRANCH" "HEAD" 2>/dev/null; then
  log "Warning: branch '$branch' is behind upstream/$BASE_BRANCH. Rebase recommended before merging upstream."
fi

# 5. Collect files changed on this branch vs upstream/<base> (three-dot diff).
#    bash 3.2: no mapfile. Use while-read.
changed_files=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  changed_files="${changed_files}${f}"$'\n'
done < <(git diff --name-only "upstream/${BASE_BRANCH}...HEAD" 2>/dev/null || true)

if [[ -z "$changed_files" ]]; then
  log "No changes vs upstream/$BASE_BRANCH. Skipping."
  exit 0
fi

# 6. Filter for core framework paths.
core_hit=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if echo "$f" | grep -Eq "$CORE_PATHS_REGEX"; then
    core_hit=1
    break
  fi
done <<EOF
$changed_files
EOF

if [[ "$core_hit" -eq 0 ]]; then
  log "No core framework files changed. Skipping upstream PR."
  exit 0
fi

# 7. PR already open? gh pr list --head owner:branch.
head_spec="${FORK_OWNER}:${branch}"
existing=""
# `--jq '.[0].number // empty'` collapses "no PRs" into an empty string.
# Without the `// empty`, jq would emit the literal "null" for an empty array
# and we would wrongly conclude a PR exists.
if ! existing="$(gh pr list --repo "$UPSTREAM_REPO" --head "$head_spec" --state open --json number --jq '.[0].number // empty' 2>/dev/null)"; then
  log "Warning: gh pr list failed. Proceeding cautiously (will not open duplicate)."
  exit 0
fi
if [[ -n "$existing" && "$existing" != "null" ]]; then
  log "PR already open on $UPSTREAM_REPO for $head_spec (#$existing). Skipping."
  exit 0
fi

# 8. Create the PR.
title="${AUTO_PR_TITLE:-$branch}"
default_body="Automated PR opened by scripts/auto-pr-upstream.sh.

Branch \`${branch}\` touched core framework files. Review the diff before merging."
body="${AUTO_PR_BODY:-$default_body}"

log "Opening PR: $UPSTREAM_REPO base=$BASE_BRANCH head=$head_spec"
if ! gh pr create --repo "$UPSTREAM_REPO" --base "$BASE_BRANCH" --head "$head_spec" --title "$title" --body "$body" 2>&1; then
  log "Warning: gh pr create failed. You may need to open the PR manually."
  exit 0
fi

log "Upstream PR opened."
exit 0
