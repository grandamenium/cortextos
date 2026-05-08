#!/usr/bin/env bash
# goal-ask.sh — park /goal and send one short clarification question.

set -euo pipefail

AGENT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$AGENT_DIR"

STATE=".claude/.goal-state.json"
LOCK=".claude/.goal-state.lock"
QUESTION=".claude/.goal-question.json"
mkdir -p .claude

question="${*:-(no question supplied)}"

python3 - "$question" <<'PY'
import json, sys, fcntl, datetime, os

lock_path = ".claude/.goal-state.lock"
state_path = ".claude/.goal-state.json"
question_path = ".claude/.goal-question.json"
question = " ".join(sys.argv[1:]).strip()
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

if not question:
    print("[goal-ask] empty question", file=sys.stderr)
    raise SystemExit(2)

lf = open(lock_path, "w")
fcntl.flock(lf, fcntl.LOCK_EX)
try:
    if os.path.exists(state_path):
        state = json.load(open(state_path))
    else:
        state = {
            "active": True,
            "started": now,
            "iteration": 0,
            "max_iterations": 50,
            "wallclock_seconds": 21600,
            "goal": "",
            "stop_fires": 0,
            "completed": False,
            "failed": False,
            "parked_seconds": 0,
            "max_questions": 5,
            "park_timeout_seconds": 14400,
        }

    count = int(state.get("question_count", 0))
    cap = int(state.get("max_questions", 5))
    if count >= cap:
        state["active"] = False
        state["completed"] = False
        state["failed"] = True
        state["parked"] = False
        state["outcome"] = "failed"
        state["failure_reason"] = f"Clarification question cap exceeded ({cap})."
        open(state_path, "w").write(json.dumps(state, indent=2))
        print(f"[goal-ask] question cap exceeded ({cap}); goal failed", file=sys.stderr)
        raise SystemExit(1)

    state["question_count"] = count + 1
    state["parked"] = True
    state["parked_at"] = now
    state["park_reason"] = question
    state["outcome"] = "parked"
    open(state_path, "w").write(json.dumps(state, indent=2))

    payload = {
        "question": question,
        "kind": "binary-or-short",
        "asked_at": now,
        "question_index": state["question_count"],
        "max_questions": cap,
        "state": "parked",
    }
    open(question_path, "w").write(json.dumps(payload, indent=2) + "\n")
    print(f"[goal-ask] parked question {state['question_count']}/{cap}")
finally:
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()
PY

message="Goal parked for clarification: ${question}"
if command -v cortextos >/dev/null 2>&1; then
    if [ -n "${CTX_TELEGRAM_CHAT_ID:-${CHAT_ID:-}}" ]; then
        chat_id="${CTX_TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"
        cortextos bus telegram-send "$chat_id" "$message" --plain-text >/dev/null 2>&1 \
            || cortextos bus send-telegram "$chat_id" "$message" --plain-text >/dev/null 2>&1 \
            || true
    else
        cortextos bus telegram-send "$message" --plain-text >/dev/null 2>&1 || true
    fi
fi
