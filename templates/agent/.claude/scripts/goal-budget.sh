#!/usr/bin/env bash
# goal-budget.sh — tracks iteration count + budget for /goal autonomous loop.
#
# Usage:
#   goal-budget.sh init <max_iters> <goal_text>     # start a new goal
#   goal-budget.sh tick                              # +1 iteration, prints "iter/max"
#   goal-budget.sh status                            # prints JSON state
#   goal-budget.sh exhausted                         # exit 0 if budget IS exhausted, exit 1 if budget remains
#   goal-budget.sh park <reason>                     # pause loop for human input
#   goal-budget.sh unpark                            # resume after human input
#   goal-budget.sh complete                          # mark active=false (goal achieved)
#   goal-budget.sh fail <reason>                     # mark active=false (blocked/failed)
#   goal-budget.sh reset                             # delete state file
#
# State lives at <agent-dir>/.claude/.goal-state.json — agent-local so
# concurrent agents in the same cortextOS repo don't clobber each other.
# Resolves agent-dir via $CLAUDE_PROJECT_DIR or falls back to pwd.

set -euo pipefail

AGENT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$AGENT_DIR"

STATE=".claude/.goal-state.json"
LOCK=".claude/.goal-state.lock"
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

try:
    max_iters = int(sys.argv[1])
except ValueError:
    max_iters = 50
max_iters = max(1, min(max_iters, 200))
goal = sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
state = {
    "active": True,
    "started": now,
    "iteration": 0,
    "max_iterations": max_iters,
    "wallclock_seconds": 21600,
    "goal": goal,
    "stop_fires": 0,
    "completed": False,
    "failed": False,
    "failure_reason": "",
    "parked": False,
    "parked_at": None,
    "park_reason": "",
    "parked_seconds": 0,
    "question_count": 0,
    "max_questions": 5,
    "park_timeout_seconds": 14400,
    "outcome": "active",
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
    s["stop_fires"] = 0
    open(state_path, "w").write(json.dumps(s, indent=2))
    print(f"[goal-budget] tick {s['iteration']}/{s['max_iterations']}")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    status)
        python3 - <<'PY'
import json, fcntl, os
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"
if not os.path.exists(state_path):
    print('{"active": false, "error": "no goal active"}')
    raise SystemExit(0)
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_SH)
try:
    print(json.dumps(json.load(open(state_path)), indent=2))
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    exhausted)
        python3 - <<'PY'
import json, sys, os, fcntl, datetime
if not os.path.exists(".claude/.goal-state.json"):
    sys.exit(0)
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"

def parse_ts(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))

lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    now = datetime.datetime.now(datetime.timezone.utc)
    if s.get("parked"):
        parked_at = parse_ts(s.get("parked_at"))
        if parked_at and (now - parked_at).total_seconds() >= s.get("park_timeout_seconds", 14400):
            s["active"] = False
            s["failed"] = True
            s["outcome"] = "park-timeout"
            s["failure_reason"] = "Park timeout exceeded while waiting for human clarification."
            s["parked"] = False
            s["parked_seconds"] = s.get("parked_seconds", 0) + int((now - parked_at).total_seconds())
            open(state_path, "w").write(json.dumps(s, indent=2))
            sys.exit(0)
        sys.exit(1)
    started = parse_ts(s.get("started"))
    elapsed = int((now - started).total_seconds()) - int(s.get("parked_seconds", 0)) if started else 0
    wallclock_exhausted = elapsed >= int(s.get("wallclock_seconds", 21600))
    budget_left = s.get("iteration", 0) < s.get("max_iterations", 50)
    done = s.get("completed") or s.get("failed") or not s.get("active", False)
    sys.exit(1 if budget_left and not wallclock_exhausted and not done else 0)
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    park)
        shift
        reason="${*:-(waiting for human clarification)}"
        python3 - "$reason" <<'PY'
import json, sys, fcntl, datetime
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"
reason = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    s["parked"] = True
    s["parked_at"] = now
    s["park_reason"] = reason
    s["outcome"] = "parked"
    open(state_path, "w").write(json.dumps(s, indent=2))
    print("[goal-budget] parked")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    unpark)
        python3 - <<'PY'
import json, fcntl, datetime
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"

def parse_ts(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))

now = datetime.datetime.now(datetime.timezone.utc)
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    parked_at = parse_ts(s.get("parked_at"))
    if parked_at:
        s["parked_seconds"] = s.get("parked_seconds", 0) + int((now - parked_at).total_seconds())
    s["parked"] = False
    s["parked_at"] = None
    s["park_reason"] = ""
    s["outcome"] = "active"
    open(state_path, "w").write(json.dumps(s, indent=2))
    print("[goal-budget] unparked")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
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
    s["parked"] = False
    s["outcome"] = "completed"
    open(state_path, "w").write(json.dumps(s, indent=2))
    print("[goal-budget] marked complete")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    fail)
        shift
        reason="${*:-(goal failed)}"
        python3 - "$reason" <<'PY'
import json, sys, fcntl
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"
reason = sys.argv[1]
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    s = json.load(open(state_path))
    s["active"] = False
    s["completed"] = False
    s["failed"] = True
    s["parked"] = False
    s["outcome"] = "failed"
    s["failure_reason"] = reason
    open(state_path, "w").write(json.dumps(s, indent=2))
    print("[goal-budget] marked failed")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        ;;
    reset)
        python3 - <<'PY'
import fcntl, os
lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"
lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    if os.path.exists(state_path):
        os.unlink(state_path)
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY
        echo "[goal-budget] state cleared"
        ;;
    *)
        echo "usage: $0 {init <max> <goal>|tick|status|exhausted|park <reason>|unpark|complete|fail <reason>|reset}" >&2
        exit 2
        ;;
esac
