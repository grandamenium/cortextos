#!/bin/bash
# skill-auto-update.sh — pull upstream changes into source-tracked skills.
#
# Scans /root/cortextos/skills/ and /root/cortextos/community/skills/ for any
# SKILL.md with a `source: <git url>` frontmatter field. For each:
#   - if the skill dir is a git working tree → `git pull --ff-only`
#   - if NOT but has source → log a 'needs-clone' warning (don't auto-clone;
#     would risk overwriting local edits without explicit operator action)
#   - on a successful pull, bump SKILL.md's `last_updated:` to today's date
#
# Designed to run weekly via system cron (NOT cortextos cron — pure shell, no
# Claude inference). Companion to /root/cortextos/bin/quota-watchdog.sh.
#
# Tunables (env):
#   SKILL_UPDATE_DRY_RUN  — "1" to log+report but skip git pull and frontmatter writes
#   SKILL_DIRS            — colon-separated list of skill catalog roots (default: framework + community)

set -uo pipefail

DRY_RUN="${SKILL_UPDATE_DRY_RUN:-0}"
DEFAULT_DIRS="/root/cortextos/skills:/root/cortextos/community/skills"
SKILL_DIRS="${SKILL_DIRS:-$DEFAULT_DIRS}"

LOG_DIR="/root/.cortextos/default/state/skill-auto-update"
LOG="$LOG_DIR/auto-update.log"
mkdir -p "$LOG_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

GIT=/usr/bin/git
SED=/usr/bin/sed

log "=== skill-auto-update start (dry_run=$DRY_RUN) ==="

PULLED=0
SKIPPED_NOSRC=0
SKIPPED_NOTGIT=0
ERRORED=0

IFS=':' read -ra DIRS <<< "$SKILL_DIRS"
for ROOT in "${DIRS[@]}"; do
  [ -d "$ROOT" ] || { log "skip root (not a dir): $ROOT"; continue; }
  for SKILL_DIR in "$ROOT"/*/; do
    SKILL_DIR="${SKILL_DIR%/}"
    SKILL_MD="$SKILL_DIR/SKILL.md"
    [ -f "$SKILL_MD" ] || continue

    NAME=$(basename "$SKILL_DIR")
    SOURCE=$(awk '/^---/{c++; next} c==1 && /^source:/{sub(/^source:[ \t]*/, ""); gsub(/^["'\''"]|["'\''"]$/, ""); print; exit}' "$SKILL_MD")

    if [ -z "$SOURCE" ]; then
      SKIPPED_NOSRC=$((SKIPPED_NOSRC + 1))
      continue
    fi

    if [ ! -d "$SKILL_DIR/.git" ]; then
      log "  [needs-clone] $NAME source=$SOURCE — not a git working tree, skipping (operator action required)"
      SKIPPED_NOTGIT=$((SKIPPED_NOTGIT + 1))
      continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
      log "  [dry-run]   $NAME would git pull --ff-only origin"
      PULLED=$((PULLED + 1))
      continue
    fi

    log "  [pulling]   $NAME"
    if ! "$GIT" -C "$SKILL_DIR" pull --ff-only --quiet 2>>"$LOG"; then
      log "    pull failed for $NAME"
      ERRORED=$((ERRORED + 1))
      continue
    fi

    TODAY=$(date -u +%Y-%m-%d)
    if grep -qE '^last_updated:' "$SKILL_MD"; then
      "$SED" -i "s|^last_updated:.*|last_updated: \"$TODAY\"|" "$SKILL_MD"
    fi
    PULLED=$((PULLED + 1))
    log "    pulled and stamped last_updated=$TODAY"
  done
done

log "=== summary: pulled=$PULLED needs_clone=$SKIPPED_NOTGIT no_source=$SKIPPED_NOSRC errors=$ERRORED ==="
exit 0
