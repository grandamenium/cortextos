#!/usr/bin/env bash
# goal-budget.sh — tracks iteration count + budget for /goal autonomous loop.
#
# Usage:
#   goal-budget.sh init <max_iters> <goal_text>     # start a new goal
#   goal-budget.sh tick                              # +1 iteration, prints "iter/max"
#   goal-budget.sh status                            # prints JSON state
#   goal-budget.sh exhausted                         # exit 0 if budget IS exhausted, exit 1 if budget remains
#   goal-budget.sh complete                          # mark active=false (goal achieved)
#   goal-budget.sh reset                             # delete state file
#
# State lives at <agent-dir>/.claude/.goal-state.json — agent-local so
# concurrent agents in the same cortextOS repo don't clobber each other.
# Resolves agent-dir via $CLAUDE_PROJECT_DIR or falls back to pwd.

set -euo pipefail

AGENT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$AGENT_DIR"

STATE=".claude/.goal-state.json"
mkdir -p .claude

cmd="${1:-status}"

case "$cmd" in
    init)
        max="${2:-50}"
        # Capture full goal text (argv[3..]) rather than only the third word
        shift 2
        goal="${*:-(unspecified)}"
        python3 - "$max" "$goal" <<'PY'
import json, sys, fcntl, datetime

lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"

max_iters = int(sys.argv[1])
goal = sys.argv[2]
state = {
    "active": True,
    "started": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "iteration": 0,
    "max_iterations": max_iters,
    "goal": goal,
    "stop_fires": 0,
    "completed": False,
}
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    open(state_path, "w").write(json.dumps(state, indent=2))
    print(f"[goal-budget] initialised — budget {max_iters} iterations")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    tick)
        python3 - <<'PY'
import json, fcntl

lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"

lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    s["iteration"] += 1
    open(state_path, "w").write(json.dumps(s, indent=2))
    print(f"[goal-budget] tick {s['iteration']}/{s['max_iterations']}")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    status)
        python3 -c "import json,sys; print(json.dumps(json.load(open('.claude/.goal-state.json')), indent=2))" \
            2>/dev/null || echo '{"active": false, "error": "no goal active"}'
        ;;
    exhausted)
        python3 - <<'PY'
import json, sys, os
if not os.path.exists(".claude/.goal-state.json"):
    sys.exit(0)
s = json.load(open(".claude/.goal-state.json"))
budget_left = s["iteration"] < s["max_iterations"] and not s.get("completed")
sys.exit(1 if budget_left else 0)
PY
        ;;
    complete)
        python3 - <<'PY'
import json, fcntl

lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"

lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    s["active"] = False
    s["completed"] = True
    open(state_path, "w").write(json.dumps(s, indent=2))
    print("[goal-budget] marked complete")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    reset)
        rm -f "$STATE"
        echo "[goal-budget] state cleared"
        ;;
    *)
        echo "usage: $0 {init <max> <goal>|tick|status|exhausted|complete|reset}" >&2
        exit 2
        ;;
esac
