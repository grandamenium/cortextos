#!/usr/bin/env bash
# End-to-end proof gate for the /goal unattended loop.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d /tmp/cortextos-goal-e2e.XXXXXX)"
INSTANCE="goal-e2e-$$"
ORG="goal-e2e"
AGENT="goal-e2e-$$"
AGENT_DIR="$WORKDIR/orgs/$ORG/agents/$AGENT"
LOG="$WORKDIR/goal-run.log"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
DEADLINE_SECONDS="${GOAL_E2E_TIMEOUT_SECONDS:-1800}"

cleanup() {
    if [ -n "${CLAUDE_PID:-}" ] && kill -0 "$CLAUDE_PID" >/dev/null 2>&1; then
        kill "$CLAUDE_PID" >/dev/null 2>&1 || true
    fi
    if [ "${GOAL_E2E_KEEP:-0}" = "1" ]; then
        echo "[goal-e2e] preserving temp dir: $WORKDIR" >&2
        return
    fi
    rm -rf "$WORKDIR"
    rm -rf "${HOME}/.cortextos/${INSTANCE}"
}
trap cleanup EXIT

mkdir -p "$WORKDIR/orgs/$ORG"
cp -R "$ROOT/templates" "$WORKDIR/templates"
cat > "$WORKDIR/orgs/$ORG/context.json" <<EOF
{
  "name": "$ORG",
  "description": "Temporary /goal e2e org",
  "timezone": "UTC",
  "orchestrator": "",
  "dashboard_url": "",
  "communication_style": "direct",
  "day_mode_start": "08:00",
  "day_mode_end": "00:00"
}
EOF

(
    cd "$WORKDIR"
    CTX_PROJECT_ROOT="$WORKDIR" "$ROOT/scripts/add-agent.sh" "$AGENT" --template agent --org "$ORG" --instance "$INSTANCE"
)

cat > "$AGENT_DIR/pyproject.toml" <<'EOF'
[tool.pytest.ini_options]
pythonpath = ["."]
EOF

mkdir -p "$AGENT_DIR/.goal-bin"
SYSTEM_PYTEST="$(command -v pytest || true)"
cat > "$AGENT_DIR/.goal-bin/pytest" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if command -v uv >/dev/null 2>&1; then
    exec uv run --python 3.13 --no-project --with pytest pytest "\$@"
fi
if [ -n "$SYSTEM_PYTEST" ]; then
    exec "$SYSTEM_PYTEST" "\$@"
fi
echo "pytest not found" >&2
exit 127
EOF
chmod +x "$AGENT_DIR/.goal-bin/pytest"
cat > "$AGENT_DIR/.goal-bin/cortextos" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ -f "$ROOT/dist/cli.js" ]; then
    exec node "$ROOT/dist/cli.js" "\$@"
fi
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/src/cli/index.ts" "\$@"
EOF
chmod +x "$AGENT_DIR/.goal-bin/cortextos"

export CLAUDE_PROJECT_DIR="$AGENT_DIR"
export CTX_PROJECT_ROOT="$WORKDIR"
export CTX_AGENT_NAME="$AGENT"
export CTX_ORG="$ORG"
export CTX_INSTANCE_ID="$INSTANCE"
export CTX_AGENT_DIR="$AGENT_DIR"
export CTX_FRAMEWORK_ROOT="$WORKDIR"
export PATH="$AGENT_DIR/.goal-bin:$PATH"

PROMPT='/goal "add hello() returning '\''world'\'' with passing pytest" --budget=10'

(
    cd "$AGENT_DIR"
    "$CLAUDE_BIN" --permission-mode bypassPermissions -p "$PROMPT"
) >"$LOG" 2>&1 &
CLAUDE_PID=$!

deadline=$((SECONDS + DEADLINE_SECONDS))
completed="false"
while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$AGENT_DIR/.claude/.goal-state.json" ]; then
        completed="$(python3 - "$AGENT_DIR/.claude/.goal-state.json" <<'PY'
import json, sys
try:
    print(str(bool(json.load(open(sys.argv[1])).get("completed", False))).lower())
except Exception:
    print("false")
PY
)"
        [ "$completed" = "true" ] && break
    fi
    if ! kill -0 "$CLAUDE_PID" >/dev/null 2>&1; then
        break
    fi
    sleep 10
done

wait "$CLAUDE_PID" || true

if [ "$completed" != "true" ]; then
    echo "[goal-e2e] goal did not complete within ${DEADLINE_SECONDS}s" >&2
    tail -n 80 "$LOG" >&2 || true
    exit 1
fi

for _ in $(seq 1 12); do
    [ -f "$AGENT_DIR/GOAL_REPORT.md" ] && break
    sleep 5
done

[ -f "$AGENT_DIR/hello.py" ] || { echo "[goal-e2e] missing hello.py" >&2; exit 1; }
[ -f "$AGENT_DIR/GOAL_REPORT.md" ] || { echo "[goal-e2e] missing GOAL_REPORT.md" >&2; exit 1; }

(
    cd "$AGENT_DIR"
    pytest
)

echo "[goal-e2e] passed"
