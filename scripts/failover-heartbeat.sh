#!/usr/bin/env bash
# Laptop-side heartbeat sender. Writes a timestamp to the droplet every 30s.
# Runs via launchd with StartInterval (launchd handles scheduling).
# Usage: failover-heartbeat.sh [droplet-host]

DROPLET_HOST="${1:-157.230.61.101}"
HEARTBEAT_FILE="/tmp/cortextos-laptop-heartbeat"

timestamp=$(date -u +%s)
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes \
    "root@${DROPLET_HOST}" "echo ${timestamp} > ${HEARTBEAT_FILE}" 2>/dev/null
exit 0
