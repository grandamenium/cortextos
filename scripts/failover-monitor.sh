#!/usr/bin/env bash
# Droplet-side failover monitor. Checks laptop heartbeat and starts/stops agents.
# Runs as a systemd service on the droplet.
# Usage: failover-monitor.sh

set -euo pipefail

HEARTBEAT_FILE="/tmp/cortextos-laptop-heartbeat"
STALE_THRESHOLD=120  # seconds before considering laptop offline
CHECK_INTERVAL=30
CORTEXTOS_DIR="/root/cortextos"
FAILOVER_ACTIVE="/tmp/cortextos-failover-active"
INSTANCE_ID="cortextos-prod"
LOG_FILE="/var/log/cortextos-failover.log"

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $1" >> "${LOG_FILE}"
}

sync_state() {
    log "Using last-synced state (laptop pushes state via heartbeat sender)"
}

start_agents() {
    if [ -f "${FAILOVER_ACTIVE}" ]; then
        return 0
    fi
    log "FAILOVER: Laptop offline for >${STALE_THRESHOLD}s. Starting agents on droplet."
    sync_state
    cd "${CORTEXTOS_DIR}"
    CTX_INSTANCE_ID="${INSTANCE_ID}" CTX_ROOT="/root/.cortextos/${INSTANCE_ID}" CTX_ORG="nyro-ct" \
        pm2 start ecosystem.config.js 2>>"${LOG_FILE}" || \
        node dist/cli.js start pa 2>>"${LOG_FILE}" &
    touch "${FAILOVER_ACTIVE}"
    log "FAILOVER: Agents started on droplet."
}

stop_agents() {
    if [ ! -f "${FAILOVER_ACTIVE}" ]; then
        return 0
    fi
    log "RECOVERY: Laptop is back online. Stopping droplet agents."
    cd "${CORTEXTOS_DIR}"
    pm2 stop all 2>>"${LOG_FILE}" || true
    pm2 delete all 2>>"${LOG_FILE}" || true
    rm -f "${FAILOVER_ACTIVE}"
    log "RECOVERY: Droplet agents stopped. Laptop has control."
}

is_laptop_alive() {
    if [ ! -f "${HEARTBEAT_FILE}" ]; then
        return 1
    fi
    local last_beat
    last_beat=$(cat "${HEARTBEAT_FILE}" 2>/dev/null || echo 0)
    local now
    now=$(date -u +%s)
    local age=$(( now - last_beat ))
    if [ "${age}" -gt "${STALE_THRESHOLD}" ]; then
        return 1
    fi
    return 0
}

log "Failover monitor started. Threshold: ${STALE_THRESHOLD}s, Check interval: ${CHECK_INTERVAL}s"

while true; do
    if is_laptop_alive; then
        stop_agents
    else
        start_agents
    fi
    sleep "${CHECK_INTERVAL}"
done
