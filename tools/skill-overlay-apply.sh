#!/usr/bin/env bash
# skill-overlay-apply.sh — enforce skill-overlay.json manifest on agent SKILL.md frontmatter
#
# Usage:
#   ./tools/skill-overlay-apply.sh [--dry-run] [--revert] [--agent <name>]
#
# --dry-run   List changes without writing
# --revert    Restore SKILL.md files from git (git checkout HEAD -- <file>)
# --agent     Only process one agent (default: all)
#
# Idempotent: running twice produces no additional changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ORGS_DIR="$REPO_ROOT/orgs"
# Skills live in the filesystem (not git-tracked). Override with --live-repo-root
# when running from a worktree where agent skill dirs are absent.
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

changes=0
errors=0

find "$ORGS_DIR" -name "skill-overlay.json" | sort | while read -r overlay_path; do
  agent_dir="$(dirname "$overlay_path")"
  agent_name="$(python3 -c "import json,sys; print(json.load(open('$overlay_path'))['agent'])" 2>/dev/null)"

  if [[ -n "$FILTER_AGENT" && "$agent_name" != "$FILTER_AGENT" ]]; then
    continue
  fi

  # Resolve skills against live repo (may differ from manifest/worktree root)
  relative_agent="${agent_dir#$ORGS_DIR/}"
  skills_dir="$LIVE_ORGS_DIR/$relative_agent/.claude/skills"
  if [[ ! -d "$skills_dir" ]]; then
    echo "[SKIP] $agent_name: no skills dir at $skills_dir"
    continue
  fi

  if $REVERT; then
    echo "[REVERT] $agent_name: restoring SKILL.md files from git (live: $skills_dir)"
    git -C "$LIVE_REPO_ROOT" checkout HEAD -- "$skills_dir/" 2>/dev/null || \
      echo "  [WARN] git revert failed for $agent_name — may not be tracked"
    continue
  fi

  # Parse manual_only and auto_invoke arrays
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

  # Process manual_only: ensure disable-model-invocation: true in frontmatter
  while IFS= read -r skill; do
    [[ -z "$skill" ]] && continue
    skill_md="$skills_dir/$skill/SKILL.md"
    if [[ ! -f "$skill_md" ]]; then
      echo "[WARN] $agent_name/$skill: SKILL.md not found (dead reference in manifest)"
      continue
    fi
    if grep -q "^disable-model-invocation:" "$skill_md" 2>/dev/null; then
      # Already has the field — ensure it's true
      current="$(grep "^disable-model-invocation:" "$skill_md" | head -1)"
      if [[ "$current" == "disable-model-invocation: true" ]]; then
        echo "[OK]   $agent_name/$skill: disable-model-invocation already true"
      else
        echo "[FIX]  $agent_name/$skill: setting disable-model-invocation: true (was: $current)"
        if ! $DRY_RUN; then
          sed -i "s/^disable-model-invocation:.*/disable-model-invocation: true/" "$skill_md"
          ((changes++)) || true
        fi
      fi
    else
      # Insert after the opening ---
      echo "[ADD]  $agent_name/$skill: adding disable-model-invocation: true"
      if ! $DRY_RUN; then
        sed -i '/^---/{n;s/^/disable-model-invocation: true\n/;:l;n;bl}' "$skill_md" 2>/dev/null || \
          python3 -c "
import re, sys
content = open('$skill_md').read()
# Insert after first --- block opener (second line after first ---)
lines = content.split('\n')
for i, line in enumerate(lines):
    if i > 0 and line == '---':
        lines.insert(i, 'disable-model-invocation: true')
        break
else:
    # Insert after first line (the opening ---)
    lines.insert(1, 'disable-model-invocation: true')
open('$skill_md', 'w').write('\n'.join(lines))
"
        ((changes++)) || true
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
        sed -i "/^disable-model-invocation: true/d" "$skill_md"
        ((changes++)) || true
      fi
    else
      echo "[OK]   $agent_name/$skill: no disable-model-invocation (correct for auto_invoke)"
    fi
  done <<< "$auto_invoke"

done

if $DRY_RUN; then
  echo ""
  echo "[DRY-RUN] No files written. Remove --dry-run to apply."
else
  echo ""
  echo "Done. $changes file(s) modified."
fi
