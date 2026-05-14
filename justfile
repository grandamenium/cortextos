# cortextOS dev recipes
# Run `just` (no args) to list available recipes.

set shell := ["bash", "-uc"]

PORT := "3010"
INSTANCE := "default"

# Default: show recipe list
default:
    @just --list

# Show what's running on the dashboard port
dashboard-status:
    #!/usr/bin/env bash
    set -u
    pids=$(lsof -tiTCP:{{PORT}} -sTCP:LISTEN -P 2>/dev/null || true)
    if [[ -z "$pids" ]]; then
        echo "Nothing listening on port {{PORT}}."
        exit 0
    fi
    ps -p $pids -o pid,etime,command

# Kill whatever is listening on the dashboard port
dashboard-stop:
    #!/usr/bin/env bash
    set -u
    pids=$(lsof -tiTCP:{{PORT}} -sTCP:LISTEN -P 2>/dev/null || true)
    if [[ -z "$pids" ]]; then
        echo "Nothing listening on port {{PORT}}."
        exit 0
    fi
    echo "Killing PID(s) on port {{PORT}}: $pids"
    kill $pids
    sleep 1
    # Force-kill anything still hanging on
    remaining=$(lsof -tiTCP:{{PORT}} -sTCP:LISTEN -P 2>/dev/null || true)
    if [[ -n "$remaining" ]]; then
        echo "Force-killing: $remaining"
        kill -9 $remaining
    fi

# Start dashboard in DEV mode (Next dev server).
# Use this for LAN / Tailscale access over plain HTTP — production-mode
# `__Secure-` cookies break login over HTTP.
# Respects DASHBOARD_ALLOWED_DEV_ORIGINS in ~/.cortextos/{{INSTANCE}}/dashboard.env.
dashboard-dev: dashboard-stop
    cortextos dashboard --port {{PORT}} --instance {{INSTANCE}}

# Start dashboard in PRODUCTION mode (next build + next start).
# Use this when accessing over HTTPS (Cloudflare Tunnel) — required for the
# secure session cookie. Will break logins if you hit it over plain HTTP from
# anything other than localhost.
dashboard-prod: dashboard-stop
    cortextos dashboard --port {{PORT}} --instance {{INSTANCE}} --build

# Restart in dev mode (alias).
dashboard-restart: dashboard-dev

# Tail the dashboard log
dashboard-logs:
    #!/usr/bin/env bash
    set -u
    log_dir="$HOME/.cortextos/{{INSTANCE}}/logs/dashboard"
    if [[ ! -d "$log_dir" ]]; then
        echo "No log dir at $log_dir yet — start the dashboard first."
        exit 1
    fi
    latest=$(ls -t "$log_dir"/*.log 2>/dev/null | head -1)
    if [[ -z "$latest" ]]; then
        echo "No log files in $log_dir yet."
        exit 1
    fi
    echo "Tailing: $latest"
    tail -f "$latest"

# Add a host/IP to DASHBOARD_ALLOWED_DEV_ORIGINS in dashboard.env.
# Usage: just dashboard-allow-origin 100.117.214.87
dashboard-allow-origin origin:
    #!/usr/bin/env bash
    set -euo pipefail
    env_file="$HOME/.cortextos/{{INSTANCE}}/dashboard.env"
    if [[ ! -f "$env_file" ]]; then
        echo "No dashboard.env at $env_file — run \`just dashboard-dev\` once to generate it." >&2
        exit 1
    fi
    if grep -q "^DASHBOARD_ALLOWED_DEV_ORIGINS=" "$env_file"; then
        current=$(grep "^DASHBOARD_ALLOWED_DEV_ORIGINS=" "$env_file" | head -1 | cut -d= -f2-)
        if [[ ",$current," == *",{{origin}},"* ]]; then
            echo "Already present: {{origin}}"
            exit 0
        fi
        new="${current:+$current,}{{origin}}"
        # macOS sed needs an empty backup arg
        sed -i '' "s|^DASHBOARD_ALLOWED_DEV_ORIGINS=.*|DASHBOARD_ALLOWED_DEV_ORIGINS=$new|" "$env_file"
    else
        echo "DASHBOARD_ALLOWED_DEV_ORIGINS={{origin}}" >> "$env_file"
    fi
    echo "Added {{origin}} to DASHBOARD_ALLOWED_DEV_ORIGINS."
    echo "Restart the dashboard for it to take effect: just dashboard-restart"
