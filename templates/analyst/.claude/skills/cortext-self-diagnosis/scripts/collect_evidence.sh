#!/usr/bin/env bash
# collect_evidence.sh — snapshot every cortextOS diagnostic surface at once.
#
# Reads a consistent moment across logs, bus, state, and daemon output so the
# investigation is not chasing files that shift underneath it. Writes a bundle
# to disk so findings survive a daemon restart (which kills the calling agent).
#
# Read-only. Never restarts, edits, or deletes anything.
#
#   bash collect_evidence.sh --agent opsbot --since 2h
#   bash collect_evidence.sh                      # whole fleet
#   bash collect_evidence.sh --out /tmp/mybundle
#
# This is a fast path over the standard layout, not a substitute for looking.
# Installs drift. A thin bundle means "go read by hand" (see surface-map.md),
# not "nothing is wrong."

set -uo pipefail   # deliberately not -e: a missing surface must not abort the run

AGENT=""; SINCE="2h"; OUT=""; TAIL_LINES=300

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --out)   OUT="${2:-}";   shift 2 ;;
    --root)  CTX_ROOT="${2:-}"; export CTX_ROOT; shift 2 ;;
    --lines) TAIL_LINES="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------- resolve runtime root (mirrors src/utils/env.ts precedence) ----------
# Precedence is env > env-file > canonical > legacy, but existence is not the same
# as being in use: installs that migrated often have an empty ~/.cortextos/<inst>
# sitting beside a populated legacy root. Picking the empty one makes a healthy
# fleet look dead, so candidates are scored by whether they actually hold agent
# data and the choice is reported.
populated() {  # echoes agent count under <root>/logs
  local r="$1"
  [ -d "$r/logs" ] || { echo 0; return; }
  ls "$r/logs" 2>/dev/null | wc -l | tr -d ' '
}

EXPLICIT_ROOT=""
ROOT="${CTX_ROOT:-}"
[ -n "$ROOT" ] && EXPLICIT_ROOT="env CTX_ROOT"
if [ -z "$ROOT" ]; then
  for f in ./.cortextos-env "$HOME/.cortextos-env"; do
    if [ -f "$f" ]; then
      ROOT=$(grep -h '^CTX_ROOT=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      [ -n "$ROOT" ] && EXPLICIT_ROOT="$f" && break
    fi
  done
fi

CANDIDATES=""
for c in "$HOME/.cortextos"/*/ "$HOME/.business-os"; do
  c="${c%/}"; [ -d "$c" ] && CANDIDATES="$CANDIDATES $c"
done

if [ -n "$ROOT" ]; then
  # Explicit setting wins, but say so when it looks unused and something else does not.
  if [ "$(populated "$ROOT")" = "0" ]; then
    for c in $CANDIDATES; do
      if [ "$c" != "$ROOT" ] && [ "$(populated "$c")" != "0" ]; then
        echo "WARN: $EXPLICIT_ROOT points at $ROOT, which has no agent logs." >&2
        echo "WARN: $c looks populated. Re-run with --root to inspect it instead." >&2
        break
      fi
    done
  fi
else
  BEST=""; BEST_N=0
  for c in $CANDIDATES; do
    n=$(populated "$c")
    [ "$n" -gt "$BEST_N" ] && BEST="$c" && BEST_N="$n"
  done
  if [ -n "$BEST" ]; then
    ROOT="$BEST"
  else
    for c in $CANDIDATES; do ROOT="$c"; break; done
  fi
fi

if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "ERROR: could not resolve runtime root." >&2
  echo "Set CTX_ROOT or pass --root. See surface-map.md section 1." >&2
  exit 1
fi

# Multiple populated roots is itself a finding worth surfacing — it is a common
# cause of "the marker is missing" when the agent reads a different root.
MULTI=""
for c in $CANDIDATES; do
  [ "$c" != "$ROOT" ] && [ "$(populated "$c")" != "0" ] && MULTI="$MULTI $c"
done
[ -n "$MULTI" ] && echo "NOTE: other populated roots present:$MULTI" >&2

STAMP=$(date +%Y%m%d-%H%M%S)
BUNDLE="${OUT:-${TMPDIR:-/tmp}/cortext-evidence-$STAMP}"
mkdir -p "$BUNDLE"/{logs,bus,state,daemon,config}

# Redact obvious secrets from anything captured. The bundle may be pasted into a
# report or a PR discussion, so scrub at write time rather than trusting later care.
redact() {
  sed -E \
    -e 's/([0-9]{8,10}:[A-Za-z0-9_-]{30,})/[REDACTED_BOT_TOKEN]/g' \
    -e 's/(sk-[A-Za-z0-9_-]{16,})/[REDACTED_KEY]/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9]{20,})/[REDACTED_GH_TOKEN]/g' \
    -e 's/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/[REDACTED_JWT]/g' \
    -e 's/((api[_-]?key|token|secret|password|authorization)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^"'"'"'[:space:],}]+/\1[REDACTED]/Ig'
}

cap() {  # cap <outfile> <label> ; command output on stdin
  local out="$1" label="$2"
  { echo "===== $label ====="; cat; echo; } | redact >> "$out" 2>/dev/null
}

echo "root:   $ROOT"
echo "bundle: $BUNDLE"
echo

# ---------- which agents ----------
if [ -n "$AGENT" ]; then
  AGENTS="$AGENT"
else
  # Directories only — logs/ also accumulates loose .log files from other tooling,
  # and counting those as agents produces phantom rows in every table below.
  AGENTS=""
  for d in "$ROOT/logs"/*/; do
    d="${d%/}"; [ -d "$d" ] && AGENTS="$AGENTS $(basename "$d")"
  done
  AGENTS="${AGENTS# }"
fi
[ -z "${AGENTS// /}" ] && echo "WARN: no agents found under $ROOT/logs" >&2

# ---------- environment ----------
{
  echo "collected:      $(date)"
  echo "runtime root:   $ROOT"
  echo "agents:         ${AGENTS:-none}"
  echo "since window:   $SINCE"
  echo "host uptime:    $(uptime 2>/dev/null)"
  echo "node:           $(node --version 2>/dev/null || echo n/a)"
  echo
  echo "--- roots present ---"
  ls -ld "$HOME/.cortextos"/* "$HOME/.business-os" 2>/dev/null
  echo
  echo "--- disk ---"
  df -h "$ROOT" 2>/dev/null | head -3
} > "$BUNDLE/ENVIRONMENT.txt" 2>&1

# ---------- daemon + pm2 ----------
pm2 list             2>&1 | cap "$BUNDLE/daemon/pm2.txt" "pm2 list"
pm2 describe cortextos-daemon 2>&1 | head -40 | cap "$BUNDLE/daemon/pm2.txt" "pm2 describe cortextos-daemon"

for f in "$HOME/.pm2/logs/cortextos-daemon-out.log" "$HOME/.pm2/logs/cortextos-daemon-error.log"; do
  [ -f "$f" ] && tail -"$TAIL_LINES" "$f" 2>/dev/null | cap "$BUNDLE/daemon/$(basename "$f").txt" "$f"
done

# Errors across the daemon log, pulled out so they are not buried in normal chatter.
if [ -f "$HOME/.pm2/logs/cortextos-daemon-out.log" ]; then
  grep -niE "error|exception|fatal|refused|timeout|ENOENT|crash|429" \
    "$HOME/.pm2/logs/cortextos-daemon-out.log" 2>/dev/null | tail -80 \
    | cap "$BUNDLE/daemon/errors-grepped.txt" "daemon-out.log error lines"
fi

[ -S "$ROOT/daemon.sock" ] && echo "daemon.sock present" > "$BUNDLE/daemon/socket.txt" \
                          || echo "daemon.sock MISSING" > "$BUNDLE/daemon/socket.txt"

# ---------- per-agent logs ----------
for a in $AGENTS; do
  d="$ROOT/logs/$a"; [ -d "$d" ] || continue
  o="$BUNDLE/logs/$a.txt"

  {
    echo "##### agent: $a #####"
    echo "--- file inventory (mtime tells you when activity stopped) ---"
    ls -la "$d" 2>/dev/null
    echo
  } >> "$o"

  for lf in stdout.log stderr.log restarts.log crashes.log fast-checker.log activity.log; do
    [ -f "$d/$lf" ] || continue
    case "$lf" in
      # Small, high-signal files: take them whole.
      restarts.log|crashes.log) tail -100 "$d/$lf" ;;
      *)                        tail -"$TAIL_LINES" "$d/$lf" ;;
    esac 2>/dev/null | cap "$o" "$a/$lf"
  done

  [ -f "$d/.crash_count_today" ] && \
    echo "crash_count_today: $(cat "$d/.crash_count_today" 2>/dev/null)" >> "$o"

  # Error signatures in stdout, surfaced separately.
  [ -f "$d/stdout.log" ] && grep -niE "error|exception|fatal|refused|timeout|ENOENT|429|rate.?limit" \
    "$d/stdout.log" 2>/dev/null | tail -40 | cap "$o" "$a/stdout.log ERROR LINES"
done

# ---------- message bus ----------
{
  echo "queue depths per agent (inflight climbing = work claimed, not finished)"
  printf "%-20s %8s %9s %10s %8s\n" AGENT INBOX INFLIGHT PROCESSED OUTBOX
  for a in $AGENTS; do
    printf "%-20s %8s %9s %10s %8s\n" "$a" \
      "$(ls "$ROOT/inbox/$a"     2>/dev/null | wc -l | tr -d ' ')" \
      "$(ls "$ROOT/inflight/$a"  2>/dev/null | wc -l | tr -d ' ')" \
      "$(ls "$ROOT/processed/$a" 2>/dev/null | wc -l | tr -d ' ')" \
      "$(ls "$ROOT/outbox/$a"    2>/dev/null | wc -l | tr -d ' ')"
  done
} > "$BUNDLE/bus/queue-depths.txt" 2>&1

for a in $AGENTS; do
  for q in inbox inflight processed outbox; do
    dir="$ROOT/$q/$a"; [ -d "$dir" ] || continue
    ls -lt "$dir" 2>/dev/null | head -10 | cap "$BUNDLE/bus/$a.txt" "$q/$a (10 most recent)"
  done
  # Stuck messages are the highest-value artifact here — capture them in full.
  if [ -d "$ROOT/inflight/$a" ] && [ -n "$(ls -A "$ROOT/inflight/$a" 2>/dev/null)" ]; then
    for m in "$ROOT/inflight/$a"/*.json; do
      [ -f "$m" ] && cat "$m" 2>/dev/null | cap "$BUNDLE/bus/$a.txt" "STUCK INFLIGHT: $(basename "$m")"
    done
  fi
done

# ---------- state + markers ----------
for a in $AGENTS; do
  o="$BUNDLE/state/$a.txt"
  [ -d "$ROOT/state/$a" ] && ls -la "$ROOT/state/$a" 2>/dev/null | cap "$o" "state/$a (markers are dotfiles)"
  # Heartbeat lives in one of two places depending on install age — try both.
  for hb in "$ROOT/state/$a/heartbeat.json" "$ROOT/state/heartbeat/$a.json"; do
    [ -f "$hb" ] && { ls -l "$hb"; cat "$hb"; } 2>/dev/null | cap "$o" "heartbeat: $hb"
  done
done

# ---------- config ----------
[ -d "$ROOT/config" ] && ls -la "$ROOT/config" 2>/dev/null | cap "$BUNDLE/config/inventory.txt" "config/"
[ -f "$ROOT/config/enabled-agents.json" ] && \
  cat "$ROOT/config/enabled-agents.json" 2>/dev/null | cap "$BUNDLE/config/enabled-agents.txt" "enabled-agents.json"

# Malformed JSON is a common crash-loop cause and is cheap to rule out here.
{
  echo "JSON validity:"
  for f in "$ROOT/config/"*.json "$ROOT/orgs/"*/crons.json; do
    [ -f "$f" ] || continue
    if python3 -m json.tool "$f" >/dev/null 2>&1; then echo "  ok   $(basename "$f")"
    else echo "  BAD  $f   <-- malformed, likely relevant"; fi
  done
} > "$BUNDLE/config/json-validity.txt" 2>&1

for c in "$ROOT/orgs/"*/crons.json; do
  [ -f "$c" ] && cat "$c" 2>/dev/null | cap "$BUNDLE/config/crons.txt" "$c"
done

# ---------- doctor ----------
command -v cortextos >/dev/null 2>&1 && \
  cortextos doctor 2>&1 | head -60 | cap "$BUNDLE/ENVIRONMENT.txt" "cortextos doctor"

# ---------- recently modified behavior files ----------
find "$ROOT" -name "*.md" -mtime -7 2>/dev/null | head -30 \
  | cap "$BUNDLE/config/recently-modified-md.txt" "behavior .md files changed in last 7 days"

# ---------- summary ----------
{
  echo "# Evidence Bundle"
  echo
  echo "- Collected: $(date)"
  echo "- Root: \`$ROOT\`"
  echo "- Agents: ${AGENTS:-none}"
  echo
  echo "## Fast signals"
  echo
  echo '```'
  echo "daemon:"
  pm2 list 2>/dev/null | grep -E "cortextos-daemon|name" | head -5 || echo "  pm2 unavailable"
  echo
  echo "queue depths:"
  sed -n '2,20p' "$BUNDLE/bus/queue-depths.txt" 2>/dev/null
  echo
  echo "crash counts:"
  for a in $AGENTS; do
    cc=$(cat "$ROOT/logs/$a/.crash_count_today" 2>/dev/null)
    [ -n "$cc" ] && [ "$cc" != "0" ] && echo "  $a: $cc"
  done
  echo
  echo "stdout freshness (stalled mtime = stopped agent):"
  for a in $AGENTS; do
    f="$ROOT/logs/$a/stdout.log"
    [ -f "$f" ] && echo "  $a: $(date -r "$f" 2>/dev/null || stat -c %y "$f" 2>/dev/null)"
  done
  echo
  echo "malformed json:"
  grep BAD "$BUNDLE/config/json-validity.txt" 2>/dev/null || echo "  none"
  echo '```'
  echo
  echo "## Contents"
  echo
  echo '```'
  # -printf is GNU-only; BSD/macOS find lacks it, so strip the prefix instead.
  ( cd "$BUNDLE" && find . -type f | sed 's|^\./||' | sort )
  echo '```'
  echo
  echo "## Next"
  echo
  echo "Route the symptom to its surface with the table in SKILL.md Phase 2, then"
  echo "work the confirm/refute pairs in \`references/symptom-playbooks.md\`."
  echo "Thin or empty sections mean read by hand — see \`references/surface-map.md\`."
} > "$BUNDLE/SUMMARY.md" 2>&1

echo "Bundle written."
echo
sed -n '/## Fast signals/,/## Contents/p' "$BUNDLE/SUMMARY.md" | head -50
echo
echo "Full summary: $BUNDLE/SUMMARY.md"
