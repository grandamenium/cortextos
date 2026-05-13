#!/usr/bin/env bash
# orchestrate.sh — multi-agent research pipeline driver.
# Dispatches claude + codex lanes in parallel, runs synth layers, drafts final report.
#
# Usage: see ../SKILL.md
#
# Output: markdown report at $OUT, structured JSON envelope to stdout for caller scripts.

set -uo pipefail

QUERY=""
FAST=0
NO_SYNTH=0
PRINCIPLES=""
OUT=""
TIMEOUT=300

while [ $# -gt 0 ]; do
  case "$1" in
    --fast)        FAST=1; shift ;;
    --no-synth)    NO_SYNTH=1; shift ;;
    --principles)  PRINCIPLES="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    --timeout)     TIMEOUT="$2"; shift 2 ;;
    -h|--help)     sed -n '2,12p' "$0" | sed 's/^# *//'; exit 0 ;;
    *)
      if [ -z "$QUERY" ]; then QUERY="$1"
      else QUERY="$QUERY $1"; fi
      shift ;;
  esac
done

[ -z "$QUERY" ] && { echo '{"verdict":"error","error":"query required"}' >&2; exit 2; }

TS=$(date +%s)
[ -z "$OUT" ] && OUT="/tmp/research-${TS}.md"
WORK="/tmp/orchestrate-${TS}-$$"
mkdir -p "$WORK"

CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/Users/subbu_ai_assistant/cortextos}"
CTX_ORG="${CTX_ORG:-subbu-ops}"
[ -z "$PRINCIPLES" ] && PRINCIPLES="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/principles.md"

# Logging helper
log() { echo "[orchestrate $(date '+%H:%M:%S')] $*" >&2; }

log "query=${QUERY:0:80}... mode=$([ $FAST -eq 1 ] && echo fast || ([ $NO_SYNTH -eq 1 ] && echo no-synth || echo full)) timeout=${TIMEOUT}s out=$OUT"

# Stage 1: dispatch research lanes in parallel
log "stage 1: research lanes (claude || codex)"
T0=$(date +%s)

# Claude lane via bus-rpc (synchronous request-reply to `research` agent)
(
  BUS_RPC="$CTX_FRAMEWORK_ROOT/community/skills/bus-rpc/bin/rpc.sh"
  if [ -x "$BUS_RPC" ]; then
    # Lane-specific timeout slightly less than the orchestrator overall budget
    # so we leave headroom for synth + draft stages.
    LANE_TIMEOUT=$((TIMEOUT - 60))
    [ $LANE_TIMEOUT -lt 30 ] && LANE_TIMEOUT=30
    rpc_out=$("$BUS_RPC" research "$QUERY" --timeout $LANE_TIMEOUT --from "${CTX_AGENT_NAME:-dev}" 2>"$WORK/claude.err")
    # Reshape into lane-output envelope (extract reply.text → body)
    python3 - <<PY > "$WORK/claude-out.json"
import json
try:
    d = json.loads('''$rpc_out''')
    if d.get("verdict") == "ok":
        print(json.dumps({
            "verdict": "ok",
            "lane": "claude",
            "body": d.get("reply", {}).get("text", ""),
            "elapsed_s": d.get("elapsed_s", 0),
            "sent_msg_id": d.get("sent_msg_id"),
        }))
    else:
        print(json.dumps({
            "verdict": d.get("verdict","error"),
            "lane": "claude",
            "body": "",
            "error": d.get("note") or d.get("error"),
        }))
except Exception as e:
    print(json.dumps({"verdict":"error","lane":"claude","body":"","error":f"rpc parse fail: {e}"}))
PY
  else
    cat > "$WORK/claude-out.json" <<EOF
{"verdict":"error","lane":"claude","error":"bus-rpc not found at $BUS_RPC — install community/skills/bus-rpc"}
EOF
  fi
) &
CLAUDE_PID=$!

CODEX_PID=""
# Codex lane is dispatched in full mode AND no-synth mode (--no-synth only
# affects synth layers, not lane dispatch). --fast is the only flag that
# skips the codex lane.
if [ $FAST -eq 0 ]; then
  (
    # Real path: ask-codex-remote.sh — actual gpt-5.5 invocation
    BRIDGE="$CTX_FRAMEWORK_ROOT/community/skills/multi-llm-bridge/bin/ask-codex-remote.sh"
    if [ -x "$BRIDGE" ]; then
      "$BRIDGE" "$QUERY" > "$WORK/codex-raw.json" 2>"$WORK/codex.err" || {
        echo '{"verdict":"error","lane":"codex","error":"ask-codex-remote failed"}' > "$WORK/codex-out.json"
        exit 0
      }
      # Reshape envelope to lane-output shape
      python3 - <<PY > "$WORK/codex-out.json"
import json
d = json.load(open("$WORK/codex-raw.json"))
print(json.dumps({
    "verdict": d.get("verdict", "error"),
    "lane": "codex",
    "backend": d.get("backend"),
    "body": d.get("body", ""),
    "elapsed_s": d.get("elapsed_s", 0),
    "tokens_used": d.get("tokens_used", 0),
}))
PY
    else
      echo '{"verdict":"error","lane":"codex","error":"ask-codex-remote not found at '$BRIDGE'"}' > "$WORK/codex-out.json"
    fi
  ) &
  CODEX_PID=$!
fi

# Wait for both lanes with overall timeout
wait_until=$(($(date +%s) + TIMEOUT))
while :; do
  done_claude=0; done_codex=0
  kill -0 $CLAUDE_PID 2>/dev/null || done_claude=1
  if [ -z "$CODEX_PID" ]; then done_codex=1
  else kill -0 $CODEX_PID 2>/dev/null || done_codex=1; fi
  [ $done_claude -eq 1 ] && [ $done_codex -eq 1 ] && break
  [ $(date +%s) -ge $wait_until ] && { log "stage 1 TIMEOUT — killing in-flight"; kill -9 $CLAUDE_PID $CODEX_PID 2>/dev/null; break; }
  sleep 1
done

STAGE1_ELAPSED=$(($(date +%s) - T0))
log "stage 1 done in ${STAGE1_ELAPSED}s"

# Stage 2: synth-compare (skipped if FAST or NO_SYNTH or codex absent)
SYNTH_COMPARE_JSON='{"verdict":"skipped"}'
if [ $FAST -eq 0 ] && [ $NO_SYNTH -eq 0 ] && [ -f "$WORK/codex-out.json" ]; then
  log "stage 2: synth-compare"
  # synth-compare is a prompt-only skill (no bin); in production this is invoked
  # as a Skill tool call by research-director. For the orchestrator-level smoke,
  # we produce a structural placeholder until the synth agents are enabled.
  python3 - <<'PY' > "$WORK/synth-compare.json"
import json
print(json.dumps({
    "verdict": "stub",
    "reason": "synth-compare is a prompt skill; orchestrator emits structural placeholder. In production: research-director invokes the synth-compare skill via Skill tool with both lane outputs as input.",
    "agree_rate": None,
    "disagree_count": 0,
    "recommended_action": "ship-as-is",
}))
PY
  SYNTH_COMPARE_JSON=$(cat "$WORK/synth-compare.json")
fi

# Stage 3: director drafts
log "stage 3: draft synthesis"
python3 - <<PY > "$WORK/draft.md"
import json
claude = json.load(open("$WORK/claude-out.json"))
codex = json.load(open("$WORK/codex-out.json")) if "$WORK/codex-out.json" and __import__("os").path.exists("$WORK/codex-out.json") else None
compare = json.loads('''$SYNTH_COMPARE_JSON''')

print(f"# {('$QUERY')[:120]}")
print()
print("## research-claude")
print(claude.get("body", "(no claude output)"))
print()
if codex:
    print("## research-codex")
    print(codex.get("body", "(no codex output)"))
    print()
if compare.get("verdict") not in ("skipped", "stub"):
    print("## synth-compare")
    print(json.dumps(compare, indent=2))
PY

# Stage 4: bias-check + principle in parallel (both stubs at orchestrator level)
SYNTH_BIAS='{"verdict":"stub","audit_score":"PASS","must_fix_before_ship":[]}'
SYNTH_PRINCIPLE='{"verdict":"stub","alignment_score":"NEUTRAL","violations":[]}'
if [ $NO_SYNTH -eq 0 ]; then
  log "stage 4: bias-check || principle (stubs at orchestrator level)"
  # In production: research-director invokes synth-bias-check + synth-principle
  # skills with the draft text. Placeholders here.
  if [ -f "$PRINCIPLES" ]; then
    log "  principles doc: $PRINCIPLES"
  else
    SYNTH_PRINCIPLE='{"verdict":"skip","reason":"no principles doc at '"$PRINCIPLES"'"}'
  fi
fi

# Stage 5: consolidate
log "stage 5: consolidate → $OUT"
TOTAL_ELAPSED=$(($(date +%s) - T0))
MODE="full"
[ $FAST -eq 1 ] && MODE="fast"
[ $NO_SYNTH -eq 1 ] && MODE="no-synth"

python3 - "$WORK/draft.md" "$OUT" "$QUERY" "$MODE" "$TOTAL_ELAPSED" "$SYNTH_COMPARE_JSON" "$SYNTH_BIAS" "$SYNTH_PRINCIPLE" <<'PYEOF'
import json, sys
draft_path, out_path, query, mode, elapsed, sc_json, sb_json, sp_json = sys.argv[1:9]
sc = json.loads(sc_json); sb = json.loads(sb_json); sp = json.loads(sp_json)
# Only count lanes that were actually dispatched. mode=fast → claude only;
# mode=no-synth → both dispatched (NO_SYNTH only skips synth layers, not the
# codex lane itself); mode=full → both dispatched.
lanes = ["claude"]
if mode == "full": lanes.append("codex")

# Determine ship_recommendation
ship = "ship"
if sb.get("audit_score") == "FAIL" or sp.get("alignment_score") == "MISALIGNED":
    ship = "rework"
elif sc.get("disagree_count", 0) > 0:
    ship = "manual-review"

frontmatter = {
    "query": query,
    "verdict": "ok" if all(j.get("verdict") not in ("error","failed") for j in (sc, sb, sp)) else "partial",
    "elapsed_s": int(elapsed),
    "mode": mode,
    "lanes": lanes,
    "synth": {"compare": sc, "bias": sb, "principle": sp},
    "ship_recommendation": ship,
}

body = open(draft_path).read()
out = "---\n"
for k, v in frontmatter.items():
    out += f"{k}: {json.dumps(v)}\n"
out += "---\n\n"
out += body

with open(out_path, "w") as f:
    f.write(out)

print(json.dumps({
    "verdict": frontmatter["verdict"],
    "ship_recommendation": ship,
    "out_path": out_path,
    "out_bytes": len(out),
    "elapsed_s": int(elapsed),
    "mode": mode,
    "lanes": lanes,
}, indent=2))
PYEOF
