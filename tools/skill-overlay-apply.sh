#!/usr/bin/env bash
# skill-overlay-apply.sh — enforce skill-overlay.json manifest on agent SKILL.md frontmatter
#
# Usage:
#   ./tools/skill-overlay-apply.sh [--dry-run] [--revert] [--agent <name>]
#                                   [--live-repo-root <path>]
#
# --dry-run          List changes without writing
# --revert           Restore SKILL.md files: tries git checkout HEAD first,
#                    falls back to .bak files created at last apply time
# --agent            Only process one agent (default: all)
# --live-repo-root   Path to live cortextos root (default: manifest root).
#                    Use when running from a worktree where skill dirs are absent.
#
# Idempotent: running twice produces no additional changes.
# Partial-failure tolerant: per-skill errors are logged but do not abort the
#   run. Re-running after a partial failure will pick up where it left off
#   because every write checks current state before acting.
# Backup-first: creates a timestamped .bak before every mutation. If the backup
#   write fails, the mutation is skipped with an error (backup-first-abort).

set -uo pipefail
# Note: NOT using -e so per-skill errors are handled locally, not script-abort.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ORGS_DIR="$REPO_ROOT/orgs"
LIVE_REPO_ROOT="$REPO_ROOT"

DRY_RUN=false
REVERT=false
FILTER_AGENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --revert)         REVERT=true ;;
    --agent)          FILTER_AGENT="$2"; shift ;;
    --live-repo-root) LIVE_REPO_ROOT="$2"; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

LIVE_ORGS_DIR="$LIVE_REPO_ROOT/orgs"

# Track changes and errors via temp files (while-read runs in subshell)
CHANGES_FILE="$(mktemp)"
ERRORS_FILE="$(mktemp)"
echo 0 > "$CHANGES_FILE"
echo 0 > "$ERRORS_FILE"
trap 'rm -f "$CHANGES_FILE" "$ERRORS_FILE"' EXIT

inc_changes() { echo $(( $(cat "$CHANGES_FILE") + 1 )) > "$CHANGES_FILE"; }
inc_errors()  { echo $(( $(cat "$ERRORS_FILE")  + 1 )) > "$ERRORS_FILE";  }

# ── Frontmatter helpers (pure Python — handles missing frontmatter correctly) ──

frontmatter_set_true() {
  local skill_md="$1"
  python3 - "$skill_md" <<'PYEOF'
import sys, re

path = sys.argv[1]
content = open(path).read()

if content.startswith('---'):
    # Has frontmatter opener
    rest = content[3:]
    # Find the closing --- (must be at start of a line)
    m = re.search(r'\n---(\n|$)', rest)
    if m:
        front = rest[:m.start()]
        after = rest[m.end():]
        if 'disable-model-invocation:' in front:
            # Update existing field
            front = re.sub(r'^disable-model-invocation:.*$', 'disable-model-invocation: true', front, flags=re.MULTILINE)
        else:
            front = 'disable-model-invocation: true\n' + front
        new_content = '---\n' + front + '\n---\n' + after
    else:
        # Malformed frontmatter (no closing ---); insert after first line
        new_content = '---\ndisable-model-invocation: true\n' + content[3:]
else:
    # No frontmatter — create minimal one
    new_content = '---\ndisable-model-invocation: true\n---\n' + content

open(path, 'w').write(new_content)
PYEOF
}

frontmatter_remove() {
  local skill_md="$1"
  sed -i "/^disable-model-invocation: true/d" "$skill_md"
}

frontmatter_update_false() {
  local skill_md="$1"
  sed -i "s/^disable-model-invocation:.*/disable-model-invocation: false/" "$skill_md"
}

# ── Backup/revert helpers ─────────────────────────────────────────────────────

BACKUP_SUFFIX=".bak.$(date +%Y%m%dT%H%M%S)"

# backup_file: creates a backup BEFORE mutation. Returns 1 (aborts caller) if
# backup write fails — never mutate without a backup in place.
backup_file() {
  local src="$1"
  local bak="${src}${BACKUP_SUFFIX}"
  if ! cp "$src" "$bak" 2>/dev/null; then
    echo "[ERROR] backup failed for $src — skipping mutation" >&2
    inc_errors
    return 1
  fi
  return 0
}

revert_file() {
  local skill_md="$1"
  local agent="$2"
  local skill="$3"
  # Try git tracked version first
  if git -C "$LIVE_REPO_ROOT" ls-files --error-unmatch "$skill_md" &>/dev/null; then
    git -C "$LIVE_REPO_ROOT" checkout HEAD -- "$skill_md" 2>/dev/null \
      && echo "[REVERT] $agent/$skill: restored from git" \
      || echo "  [WARN] $agent/$skill: git tracked but checkout failed"
  else
    # Fall back to most-recent .bak
    local latest_bak
    latest_bak=$(ls -t "${skill_md}.bak."* 2>/dev/null | head -1)
    if [[ -n "$latest_bak" ]]; then
      cp "$latest_bak" "$skill_md"
      echo "[REVERT] $agent/$skill: restored from backup $latest_bak"
    else
      echo "  [WARN] $agent/$skill: not git-tracked and no backup found — cannot revert"
    fi
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────────────

find "$ORGS_DIR" -name "skill-overlay.json" | sort | while read -r overlay_path; do
  agent_dir="$(dirname "$overlay_path")"
  agent_name="$(python3 -c "import json,sys; print(json.load(open('$overlay_path'))['agent'])" 2>/dev/null)"

  if [[ -n "$FILTER_AGENT" && "$agent_name" != "$FILTER_AGENT" ]]; then
    continue
  fi

  relative_agent="${agent_dir#$ORGS_DIR/}"
  skills_dir="$LIVE_ORGS_DIR/$relative_agent/.claude/skills"
  if [[ ! -d "$skills_dir" ]]; then
    echo "[SKIP] $agent_name: no skills dir at $skills_dir"
    continue
  fi

  if $REVERT; then
    manual_only="$(python3 -c "import json; d=json.load(open('$overlay_path')); print('\n'.join(d.get('manual_only',[])))")"
    auto_invoke="$(python3 -c "import json; d=json.load(open('$overlay_path')); print('\n'.join(d.get('auto_invoke',[])))")"
    for skill in $manual_only $auto_invoke; do
      [[ -z "$skill" ]] && continue
      skill_md="$skills_dir/$skill/SKILL.md"
      [[ ! -f "$skill_md" ]] && continue
      revert_file "$skill_md" "$agent_name" "$skill"
    done
    continue
  fi

  manual_only="$(python3 -c "
import json, sys
data = json.load(open('$overlay_path'))
print('\n'.join(data.get('manual_only', [])))
")"
  auto_invoke="$(python3 -c "
import json, sys
data = json.load(open('$overlay_path'))
print('\n'.join(data.get('auto_invoke', [])))
")"

  # Process manual_only: ensure disable-model-invocation: true
  while IFS= read -r skill; do
    [[ -z "$skill" ]] && continue
    skill_md="$skills_dir/$skill/SKILL.md"
    if [[ ! -f "$skill_md" ]]; then
      echo "[WARN] $agent_name/$skill: SKILL.md not found (dead reference in manifest)"
      continue
    fi
    if grep -q "^disable-model-invocation: true" "$skill_md" 2>/dev/null; then
      echo "[OK]   $agent_name/$skill: disable-model-invocation already true"
    elif grep -q "^disable-model-invocation:" "$skill_md" 2>/dev/null; then
      current="$(grep "^disable-model-invocation:" "$skill_md" | head -1)"
      echo "[FIX]  $agent_name/$skill: setting disable-model-invocation: true (was: $current)"
      if ! $DRY_RUN; then
        if backup_file "$skill_md"; then
          sed -i "s/^disable-model-invocation:.*/disable-model-invocation: true/" "$skill_md"
          inc_changes
        fi
      fi
    else
      echo "[ADD]  $agent_name/$skill: adding disable-model-invocation: true"
      if ! $DRY_RUN; then
        if backup_file "$skill_md"; then
          frontmatter_set_true "$skill_md"
          inc_changes
        fi
      fi
    fi
  done <<< "$manual_only"

  # Process auto_invoke: ensure disable-model-invocation is absent or false
  while IFS= read -r skill; do
    [[ -z "$skill" ]] && continue
    skill_md="$skills_dir/$skill/SKILL.md"
    if [[ ! -f "$skill_md" ]]; then
      echo "[WARN] $agent_name/$skill: SKILL.md not found (dead reference in manifest)"
      continue
    fi
    if grep -q "^disable-model-invocation: true" "$skill_md" 2>/dev/null; then
      echo "[FIX]  $agent_name/$skill: removing disable-model-invocation: true (auto_invoke)"
      if ! $DRY_RUN; then
        if backup_file "$skill_md"; then
          frontmatter_remove "$skill_md"
          inc_changes
        fi
      fi
    else
      echo "[OK]   $agent_name/$skill: no disable-model-invocation (correct for auto_invoke)"
    fi
  done <<< "$auto_invoke"

done

FINAL_CHANGES=$(cat "$CHANGES_FILE")
FINAL_ERRORS=$(cat "$ERRORS_FILE")
if $DRY_RUN; then
  echo ""
  echo "[DRY-RUN] No files written. Remove --dry-run to apply."
else
  echo ""
  if (( FINAL_ERRORS > 0 )); then
    echo "Done. ${FINAL_CHANGES} file(s) modified, ${FINAL_ERRORS} error(s) — re-run to retry skipped files."
    exit 1
  else
    echo "Done. ${FINAL_CHANGES} file(s) modified."
  fi
fi
