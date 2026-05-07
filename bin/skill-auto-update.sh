#!/bin/bash
# skill-auto-update.sh — pull upstream changes into source-tracked skills.
#
# Scans /root/cortextos/skills/ and /root/cortextos/community/skills/ for any
# SKILL.md with a `source: <git url>` frontmatter field. Two patterns
# supported:
#
#   Pattern A — flat clone (no source_subpath):
#     The skill dir IS a git working tree. `git pull --ff-only` runs in
#     place. SKILL.md lives at the root of the upstream repo.
#
#   Pattern B — subpath via cache-clone + rsync (source_subpath set):
#     The upstream repo is something else (e.g. a parent that holds the
#     skill at `.claude/skills/<slug>/`). We:
#       1. Clone the parent into <CTX_ROOT>/state/skill-update-cache/<slug>
#          on first run; `git pull --ff-only` on subsequent runs.
#       2. Rsync <cache>/<source_subpath>/ → <skill_dir>/, EXCLUDING SKILL.md
#          so any local frontmatter additions (version/source/source_subpath
#          themselves, last_updated) survive.
#       3. Update <skill_dir>/SKILL.md's `last_updated:` field via sed.
#
# In either pattern, on a successful pull we bump `last_updated:` to today.
#
# Skills with neither `source:` nor `source_subpath:` are silently skipped.
# Skills with `source:` but no .git AND no source_subpath are flagged
# `needs-clone` (operator must convert manually — risk of overwriting
# local edits is too high to auto-clone in place).
#
# Designed to run weekly via system cron. Pure shell, no Claude inference.
#
# Tunables (env):
#   SKILL_UPDATE_DRY_RUN  — "1" to log+report but skip git pull and writes
#   SKILL_DIRS            — colon-separated list of skill catalog roots
#                           (default: framework + community)
#   CTX_ROOT              — default /root/.cortextos/default

set -uo pipefail

DRY_RUN="${SKILL_UPDATE_DRY_RUN:-0}"
DEFAULT_DIRS="/root/cortextos/skills:/root/cortextos/community/skills"
SKILL_DIRS="${SKILL_DIRS:-$DEFAULT_DIRS}"
CTX_ROOT="${CTX_ROOT:-/root/.cortextos/default}"

LOG_DIR="$CTX_ROOT/state/skill-auto-update"
CACHE_DIR="$CTX_ROOT/state/skill-update-cache"
LOG="$LOG_DIR/auto-update.log"
mkdir -p "$LOG_DIR" "$CACHE_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

GIT=/usr/bin/git
SED=/usr/bin/sed
RSYNC=/usr/bin/rsync

# parse_frontmatter <skill.md> <field>  → prints field value (empty if missing)
parse_frontmatter() {
  awk -v fld="$2" '
    /^---/ { c++; next }
    c==1 && $0 ~ "^"fld":" {
      sub("^"fld":[ \t]*", "")
      gsub(/^["\047]|["\047]$/, "")
      print
      exit
    }
  ' "$1"
}

bump_last_updated() {
  local skill_md="$1"
  local today
  today=$(date -u +%Y-%m-%d)
  if grep -qE '^last_updated:' "$skill_md"; then
    "$SED" -i "s|^last_updated:.*|last_updated: \"$today\"|" "$skill_md"
  fi
}

log "=== skill-auto-update start (dry_run=$DRY_RUN) ==="

PULLED=0
SKIPPED_NOSRC=0
SKIPPED_NOTGIT=0
ERRORED=0
RSYNCED=0

IFS=':' read -ra DIRS <<< "$SKILL_DIRS"
for ROOT in "${DIRS[@]}"; do
  [ -d "$ROOT" ] || { log "skip root (not a dir): $ROOT"; continue; }
  for SKILL_DIR in "$ROOT"/*/; do
    SKILL_DIR="${SKILL_DIR%/}"
    SKILL_MD="$SKILL_DIR/SKILL.md"
    [ -f "$SKILL_MD" ] || continue

    NAME=$(basename "$SKILL_DIR")
    SOURCE=$(parse_frontmatter "$SKILL_MD" source)
    SUBPATH=$(parse_frontmatter "$SKILL_MD" source_subpath)

    if [ -z "$SOURCE" ]; then
      SKIPPED_NOSRC=$((SKIPPED_NOSRC + 1))
      continue
    fi

    # ---------- Pattern B: source_subpath set → cache-clone + rsync ----------
    if [ -n "$SUBPATH" ]; then
      CACHE_PATH="$CACHE_DIR/$NAME"
      if [ ! -d "$CACHE_PATH/.git" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          log "  [dry-run]   $NAME would clone $SOURCE → $CACHE_PATH (subpath=$SUBPATH)"
          PULLED=$((PULLED + 1))
          continue
        fi
        log "  [cloning]   $NAME parent → $CACHE_PATH"
        if ! "$GIT" clone --quiet "$SOURCE" "$CACHE_PATH" 2>>"$LOG"; then
          log "    clone failed for $NAME"
          ERRORED=$((ERRORED + 1))
          continue
        fi
      else
        if [ "$DRY_RUN" = "1" ]; then
          log "  [dry-run]   $NAME would git pull --ff-only in $CACHE_PATH + rsync subpath=$SUBPATH"
          PULLED=$((PULLED + 1))
          continue
        fi
        log "  [pulling]   $NAME parent in $CACHE_PATH"
        if ! "$GIT" -C "$CACHE_PATH" pull --ff-only --quiet 2>>"$LOG"; then
          log "    parent-pull failed for $NAME"
          ERRORED=$((ERRORED + 1))
          continue
        fi
      fi

      SRC="$CACHE_PATH/$SUBPATH/"
      if [ ! -d "$SRC" ]; then
        log "    source_subpath does not exist in upstream: $SRC"
        ERRORED=$((ERRORED + 1))
        continue
      fi

      # Rsync content from upstream subpath into local skill dir.
      # -L dereferences symlinks (some upstream skills, e.g. ui-ux-pro-max,
      # use relative symlinks like `data → ../../../src/skill-name/data` to
      # share content across multiple skill directories in the parent repo —
      # we want the actual content materialized standalone in the local copy).
      # --exclude=SKILL.md keeps local frontmatter additions intact.
      # No --delete: additive only, so files removed upstream stay locally
      # (operator can clean manually if needed). Safer default.
      log "    rsyncing $SRC → $SKILL_DIR/ (-L deref, excluding SKILL.md)"
      if ! "$RSYNC" -aL --exclude='SKILL.md' "$SRC" "$SKILL_DIR/" 2>>"$LOG"; then
        log "    rsync failed for $NAME"
        ERRORED=$((ERRORED + 1))
        continue
      fi

      bump_last_updated "$SKILL_MD"
      RSYNCED=$((RSYNCED + 1))
      PULLED=$((PULLED + 1))
      log "    pulled+rsynced $NAME and stamped last_updated"
      continue
    fi

    # ---------- Pattern A: flat clone (no source_subpath) ----------
    if [ ! -d "$SKILL_DIR/.git" ]; then
      log "  [needs-clone] $NAME source=$SOURCE — not a git working tree, skipping (operator action required)"
      SKIPPED_NOTGIT=$((SKIPPED_NOTGIT + 1))
      continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
      log "  [dry-run]   $NAME would git pull --ff-only origin (flat)"
      PULLED=$((PULLED + 1))
      continue
    fi

    log "  [pulling]   $NAME (flat)"
    if ! "$GIT" -C "$SKILL_DIR" pull --ff-only --quiet 2>>"$LOG"; then
      log "    pull failed for $NAME"
      ERRORED=$((ERRORED + 1))
      continue
    fi

    bump_last_updated "$SKILL_MD"
    PULLED=$((PULLED + 1))
    log "    pulled and stamped last_updated"
  done
done

log "=== summary: pulled=$PULLED (rsynced=$RSYNCED) needs_clone=$SKIPPED_NOTGIT no_source=$SKIPPED_NOSRC errors=$ERRORED ==="
exit 0
